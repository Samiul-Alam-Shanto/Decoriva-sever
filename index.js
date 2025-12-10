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

async function run() {
  try {
    // Connect to MongoDB
    await client.connect();
    const db = client.db("Decoriva_DB");

    const servicesCollection = db.collection("services");

    //  service related API's
    app.get("/services", async (req, res) => {
      const {
        search,
        category,
        minPrice,
        maxPrice,
        page = 1,
        limit = 6,
      } = req.query;
      let query = {};

      if (search) query.service_name = { $regex: search, $options: "i" };
      if (category && category !== "All") query.category = category;
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
        .toArray();

      res.send({
        services: result,
        totalServices: total,
        currentPage: pageNum,
        totalPages: Math.ceil(total / limitNum),
      });
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

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
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
