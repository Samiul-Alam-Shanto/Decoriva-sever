const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const stripe = require("stripe");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 5000;

// Initialize Stripe
const stripeClient = stripe(process.env.STRIPE_SECRET_KEY);

// Initialize Firebase Admin
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log("Firebase Admin Initialized Successfully");
} catch (error) {
  console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT.");
}

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// MongoDB Connection URI
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@shanto.jdnmzty.mongodb.net/?appName=shanto`;

// Create MongoClient
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const verifyFBToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send({ message: "unauthorized access" });
  }
  try {
    const token = authHeader.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(token);
    req.decoded_email = decoded.email;
    next();
  } catch (error) {
    console.error("Token Verification Error:", error.message);
    return res.status(401).send({ message: "unauthorized access" });
  }
};

async function run() {
  try {
    // Connect to MongoDB
    // await client.connect();
    const db = client.db("Decoriva_DB");

    const servicesCollection = db.collection("services");
    const usersCollection = db.collection("users");
    const bookingsCollection = db.collection("bookings");
    const decoratorRequestsCollection = db.collection("decoratorRequests");

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user || user.role !== "admin") {
        res.status(403).send({ message: "Forbidden Access" });
      }
      next();
    };
    //!  USER related api's

    // Save or Update User on Login/Register
    app.post("/auth/user", verifyFBToken, async (req, res) => {
      const user = req.body;
      const query = { email: user.email };

      // Check if user exists
      const existingUser = await usersCollection.findOne(query);
      if (existingUser) {
        return res.send({ message: "User already exists", insertedId: null });
      }

      // Default role is 'user' if not provided
      const result = await usersCollection.insertOne({
        ...user,
        role: "user",
        createdAt: new Date(),
      });
      res.send(result);
    });

    // Get User Role
    app.get("/users/role/:email", verifyFBToken, async (req, res) => {
      const email = req.params.email;
      if (req.decoded_email !== email) {
        return res.status(403).send({ message: "forbidden" });
      }
      const user = await usersCollection.findOne({ email });
      res.send({ role: user?.role || "user" });
    });

    //admin stats
    app.get("/stats", verifyFBToken, verifyAdmin, async (req, res) => {
      const totalUsers = await usersCollection.countDocuments();
      const totalServices = await servicesCollection.countDocuments();
      const totalBookings = await bookingsCollection.countDocuments();

      const revenueData = await bookingsCollection
        .aggregate([
          { $match: { status: { $ne: "pending" } } },
          { $group: { _id: null, total: { $sum: "$price" } } },
        ])
        .toArray();

      const revenue = revenueData.length > 0 ? revenueData[0].total : 0;

      res.send({ totalUsers, totalServices, totalBookings, revenue });
    });

    //get all users

    app.get("/users", verifyFBToken, verifyAdmin, async (req, res) => {
      const result = await usersCollection.find().toArray();
      res.send(result);
    });

    //admin handle roles

    app.patch(
      "/users/role/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const { role } = req.body;

        const filter = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: { role: role },
        };

        const result = await usersCollection.updateOne(filter, updateDoc);
        res.send(result);
      }
    );

    //get decorators list
    app.get(
      "/admin/decorators",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const query = { role: "decorator" };
        const result = await usersCollection.find(query).toArray();
        res.send(result);
      }
    );

    //? Decorator related API's

    app.post("/decorator-requests", verifyFBToken, async (req, res) => {
      const request = req.body;
      const existing = await decoratorRequestsCollection.findOne({
        email: request.email,
      });
      if (existing) {
        return res.send({ message: "Request already pending or processed" });
      }
      const result = await decoratorRequestsCollection.insertOne(request);
      res.send(result);
    });

    app.get(
      "/decorator-requests",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const result = await decoratorRequestsCollection.find().toArray();
        res.send(result);
      }
    );

    app.patch(
      "/decorator-requests/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const { status, email } = req.body;

        const filter = { _id: new ObjectId(id) };
        const updateDoc = { $set: { status: status } };
        await decoratorRequestsCollection.updateOne(filter, updateDoc);

        if (status === "approved") {
          await usersCollection.updateOne(
            { email: email },
            { $set: { role: "decorator" } }
          );
        }

        res.send({ success: true });
      }
    );

    //!  SERVICE related API's
    app.get("/services", async (req, res) => {
      const {
        search,
        category,
        location,
        minPrice,
        maxPrice,
        page = 1,
        limit = 6,
      } = req.query;
      let query = {};

      if (search) query.service_name = { $regex: search, $options: "i" };
      if (category && category !== "All") query.category = category;
      if (location && location !== "All") {
        query.location = location;
      }
      if (minPrice || maxPrice) {
        query.cost = {};
        if (minPrice) query.cost.$gte = parseInt(minPrice);
        if (maxPrice) query.cost.$lte = parseInt(maxPrice);
      }

      // Pagination Logic
      const pageNum = parseInt(page);
      const limitNum = parseInt(limit);
      const skip = (pageNum - 1) * limitNum;

      const total = await servicesCollection.countDocuments(query);
      const result = await servicesCollection
        .find(query)
        .skip(skip)
        .limit(limitNum)
        .sort({ createdAt: -1 })
        .toArray();

      res.send({
        services: result,
        totalServices: total,
        currentPage: pageNum,
        totalPages: Math.ceil(total / limitNum),
      });
    });

    // Get Single Service Details
    app.get("/services/:id", async (req, res) => {
      const id = req.params.id;
      const result = await servicesCollection.findOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    //for getting locations dynamically from backend
    app.get("/services/locations/category", async (req, res) => {
      try {
        const result = await servicesCollection
          .aggregate([
            {
              $match: {
                location: { $exists: true, $ne: null, $ne: "" },
              },
            },
            {
              $group: {
                _id: "$location",
              },
            },
            {
              $project: {
                _id: 0,
                location: "$_id",
              },
            },
          ])
          .toArray();

        res.send(result.map((i) => i.location));
      } catch (error) {
        console.error("Location Fetch Error →", error);
        res.status(500).send({ message: "Failed to fetch locations" });
      }
    });

    //add a service
    app.post("/services", verifyFBToken, verifyAdmin, async (req, res) => {
      const service = req.body;
      const result = await servicesCollection.insertOne(service);
      res.send(result);
    });

    // Update Service
    app.patch("/services/:id", verifyFBToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const item = req.body;
      delete item._id;

      if (item.cost) {
        item.cost = parseInt(item.cost);
      }

      const filter = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: { ...item },
      };

      const result = await servicesCollection.updateOne(filter, updatedDoc);
      res.send(result);
    });

    // Delete Service
    app.delete(
      "/services/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const result = await servicesCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.send(result);
      }
    );

    //! PAYMENT API's

    const VALID_COUPONS = {
      SAVE10: 0.1,
      STYLE20: 0.2,
    };

    app.post("/create-checkout-session", verifyFBToken, async (req, res) => {
      try {
        const {
          bookingId,
          serviceName,
          price,
          userEmail,
          addons = [],
          couponCode,
        } = req.body;

        let finalAmount = parseInt(price);

        let addonsCost = 0;
        if (addons.length > 0) {
          addonsCost = addons.reduce((acc, item) => acc + item.price, 0);
          finalAmount += addonsCost;
        }

        let discountAmount = 0;
        if (couponCode && VALID_COUPONS[couponCode]) {
          discountAmount = finalAmount * VALID_COUPONS[couponCode];
          finalAmount -= discountAmount;
        }

        const clientUrl = process.env.CLIENT_URL || "http://localhost:5173";

        const session = await stripeClient.checkout.sessions.create({
          payment_method_types: ["card"],

          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: {
                  name: `${serviceName} + Addons ${
                    couponCode ? "(Discount Applied)" : ""
                  }`,
                  description: `Base: $${price}, Addons: $${addonsCost}, Discount: -$${discountAmount}`,
                },
                unit_amount: Math.round(finalAmount * 100),
              },
              quantity: 1,
            },
          ],
          mode: "payment",
          metadata: {
            bookingId: bookingId.toString(),
            userEmail,
            couponUsed: couponCode || "none",
          },
          success_url: `${clientUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}&bookingId=${bookingId}`,
          cancel_url: `${clientUrl}/services`,
        });

        res.send({ url: session.url });
      } catch (error) {
        console.error("Stripe Error:", error);
        res.status(400).send({ message: error.message });
      }
    });

    app.post("/payments/verify", verifyFBToken, async (req, res) => {
      const { sessionId, bookingId } = req.body;

      const session = await stripeClient.checkout.sessions.retrieve(sessionId);
      if (session.payment_status === "paid") {
        // Update booking to paid
        await bookingsCollection.updateOne(
          { _id: new ObjectId(bookingId) },
          { $set: { status: "paid", transactionId: session.payment_intent } }
        );
        res.send({ success: true });
      } else {
        res.status(400).send({ success: false });
      }
    });

    //! BOOKING API's

    // Create Booking
    app.post("/bookings", verifyFBToken, async (req, res) => {
      const booking = req.body;
      booking.status = "pending";
      booking.createdAt = new Date();
      const result = await bookingsCollection.insertOne(booking);
      res.send(result);
    });
    //get booking info
    app.get("/bookings", verifyFBToken, async (req, res) => {
      const email = req.decoded_email;
      const user = await usersCollection.findOne({ email });

      let query = {};

      if (user.role === "admin") {
        query = {};
      } else if (user.role === "decorator") {
        query = { decoratorEmail: email };
      } else {
        query = { userEmail: email };
      }
      // console.log(query);
      const result = await bookingsCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();
      res.send(result);
    });

    // Update Booking Status // update separate with roles
    app.patch("/bookings/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const updates = req.body;
      const email = req.decoded_email;

      const requester = await usersCollection.findOne({ email });
      if (!requester)
        return res.status(403).send({ message: "User not found" });

      const filter = { _id: new ObjectId(id) };
      let updateDoc = {};

      if (requester.role === "admin") {
        updateDoc = { ...updates };
        delete updateDoc._id;
      } else if (requester.role === "decorator") {
        filter.decoratorEmail = email;
        if (updates.status) updateDoc.status = updates.status;
      } else {
        return res.status(403).send({ message: "Action forbidden for users" });
      }

      const result = await bookingsCollection.updateOne(filter, {
        $set: updateDoc,
      });
      if (result.matchedCount === 0) {
        return res.status(403).send({
          message: "Booking not found or you are not authorized to edit it.",
        });
      }

      res.send(result);
    });

    // Cancel Booking (User Only )
    app.delete("/bookings/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      const booking = await bookingsCollection.findOne(query);
      if (booking.status !== "pending") {
        return res
          .status(403)
          .send({ message: "Cannot cancel processed booking" });
      }

      const result = await bookingsCollection.deleteOne(query);
      res.send(result);
    });

    // await client.db("admin").command({ ping: 1 });
    // console.log(
    //   "Pinged your deployment. You successfully connected to MongoDB!"
    // );
  } finally {
    // await client.close();
  }
}
run().catch(console.dir);
// --- Root Route ---
app.get("/", (req, res) => {
  res.send("Decoriva API is running ");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
