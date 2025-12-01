require("dotenv").config();
var admin = require("firebase-admin");
const { v4: uuidv4 } = require("uuid");
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const express = require("express");
const cors = require("cors");
const app = express();
//tracking id creating function
const trackingId = uuidv4();
//middleware
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

//firebase middleware
const serviceAccount = require("./zapshift-firebsase-secret.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const verifyFBToken = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header) {
    return res.status(401).send({ message: "unauthorized access" });
  }
  const token = header.split(" ")[1];
  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.decoded_email = decoded.email;
    next();
  } catch (error) {
    return res.status(401).send({ message: "unauthorized access" });
  }
};
//middleware for database access

const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    const db = client.db("zapshift_db");
    const parcelsCollection = db.collection("parcels");
    const paymentsCollection = db.collection("payments");
    const usersCollection = db.collection("users");
    const ridersCollection = db.collection("riders");

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "Access Forbidded" });
      }
      next();
    };

    //user related api
    app.get("/users", verifyFBToken, verifyAdmin, async (req, res) => {
      const email = req.query.email;
      const query = {};
      if (email) {
        query.email = email;
        if (req.decoded_email !== email) {
          return res.status(403).send({ message: "Access Forbidden" });
        }

      }
      if(req.query.searchText){
          query.$or = [{
            displayName: {$regex: req.query.searchText, $options: 'i'}
          },
          {
            email: {$regex: req.query.searchText, $options: 'i'}
          }

          ]
        }
        
      const cursor = usersCollection.find(query).limit(3);
      const result = await cursor.toArray();

      res.send(result);
    });
    app.post("/users", async (req, res) => {
      const user = req.body;
      console.log(user);
      user.role = "user";
      user.createdAt = new Date();
      const email = user.email;
      const userExists = await usersCollection.findOne({ email });
      if (userExists) {
        return res.send({ message: "user already exists" });
      }
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });
    app.patch("/users/:id", async (req, res) => {
      const id = req.params.id;
      const roleInfo = req.body;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          role: roleInfo.role,
        },
      };
      const result = await usersCollection.updateOne(query, updateDoc);
      res.send(result);
    });

    app.get("/parcels", verifyFBToken, async (req, res) => {
      // console.log(req.headers.authorization)
      const email = req.query.email;
      const query = {};
      if (email) {
        query.senderEmail = email;
        if (req.decoded_email !== email) {
          return res.status(403).send({ message: "access forbidden" });
        }
      }
      const cursor = parcelsCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });
    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.findOne(query);
      res.send(result);
    });
    //stripe create checkout
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;

      const amount = parseInt(paymentInfo.cost * 100);
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: amount,
              product_data: {
                name: paymentInfo.parcelName,
              },
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        payment_intent_data: {
          metadata: {
            parcelId: paymentInfo.parcelId,
            customer_email: paymentInfo.senderEmail,
            parcelName: paymentInfo.parcelName,
          },
        },

        success_url: `${process.env.SITE_DOMAIN}/dashboard/paymentSuccess?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/cancelPayment`,
      });
      // console.log(session);
      res.send(session);
    });
    app.post("/sendParcel", async (req, res) => {
      const parcelData = req.body;

      const result = await parcelsCollection.insertOne(parcelData);
      res.send(result);
    });
    app.patch("/paymentSuccess", async (req, res) => {
      const sessionId = req.query.session_id;
      // console.log(sessionId)
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const paymentIntent = await stripe.paymentIntents.retrieve(
        session.payment_intent
      );
      //  console.log('payment data',paymentIntent);
      //  console.log( 'session details',session)

      if (session.payment_status === "paid") {
        const id = paymentIntent.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            paymentStatus: "paid",
          },
        };
        const result = await parcelsCollection.updateOne(query, update);

        const transectionId = session.payment_intent;
        const queryData = { transectionId: transectionId };
        const paymentExists = await paymentsCollection.findOne(queryData);
        if (paymentExists) {
          return res.send({ message: "already exists" });
        }
        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customer_email: paymentIntent.metadata.customer_email,
          parcelId: paymentIntent.metadata.parcelId,
          parcelName: paymentIntent.metadata.parcelName,
          paymentStatus: session.payment_status,
          transectionId: session.payment_intent,
          tracikingId: trackingId,
          paidAt: new Date(),
        };
        const paymentResult = await paymentsCollection.insertOne(payment);

        res.send({
          success: true,
          modifyParcelInfo: result,
          paymentInsertInfo: paymentResult,
          paymentInfo: payment,
        });
      } else {
        res.send({ success: false });
      }
    });
    //payment related api
    app.get("/payments", async (req, res) => {
      // console.log('hitten')
      const email = req.query.email;
      const query = {};
      if (email) {
        query.customer_email = email;
      }
      const cursor = paymentsCollection.find(query).sort({ paidAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });
    //rider related api
    app.get("/riders", async (req, res) => {
      const status = req.query.status;
      const query = {};
      if (status) {
        query.status = status;
      }
      const cursor = ridersCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.post("/riders", async (req, res) => {
      const rider = req.body;
      rider.status = "pending";
      rider.createdAt = new Date();
      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });
    app.patch("/riders/:id", async (req, res) => {
      const id = req.params.id;
      const status = req.body.status;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          status: status,
        },
      };
      const result = await ridersCollection.updateOne(query, updateDoc);
      let userResult = null;
      if (status === "Approved") {
        const email = req.body.email;
        const userQuery = { email };
        const updateUser = {
          $set: {
            role: "rider",
          },
        };
        userResult = await usersCollection.updateOne(userQuery, updateUser);
      }
      res.send(userResult ?? result);
    });

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.deleteOne(query);
      res.send(result);
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    //await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Zapshift server is running");
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`the server is running at port ${port}`);
});
