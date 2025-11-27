require('dotenv').config()
const { MongoClient, ServerApiVersion } = require('mongodb');
const express = require('express')
const cors = require('cors')
const app = express()
//middleware
app.use(cors())
app.use(express.json())



const uri = process.env.MONGODB_URI;


const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {

    await client.connect();
    const db = client.db('zapshift_db')
    const parcelsCollection = db.collection('parcels');

    app.get('/parcels',async(req,res)=>{
        const email = req.query.email;
        const query ={}
        if(email){
            query.senderEmail = email;
        }
        const cursor =  parcelsCollection.find(query);
        const result = await cursor.toArray()
        res.send(result);
    })
    app.post('/sendParcel', async(req,res)=>{
        const parcelData = req.body;

        const result = await parcelsCollection.insertOne(parcelData);
        res.send(result);
    })

    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {

    //await client.close();
  }
}
run().catch(console.dir);

app.get('/',(req,res)=>{
    res.send('Zapshift server is running')
})

const port = process.env.PORT||4000;
app.listen(port,()=>{
    console.log(`the server is running at port ${port}`);
})