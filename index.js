const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();

const port = process.env.PORT || 5000;

// middleware
app.use(cors());
app.use(express.json());



const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.8jrtwg1.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });

// verifyJWT
function verifyJWT (req, res, next) {
    // console.log('token inside bearer', req.headers.authorization);
    const authHeader = req.headers.authorization;

    if(!authHeader){
        return res.status(401).send('unauthorized access');
    }

    const token = authHeader.split(' ')[1];
    
    jwt.verify(token, process.env.ACCESS_TOKEN, function(err, decoded){
        if(err){
            res.status(403).send({message: 'Forbidden access'});
        }
        req.decoded = decoded;
        next();
    })
}

async function run() {
    try{
        const appointmentOptionCollection = client.db('doctorsPortal').collection('appointmentOptions');
        const bookingsCollection = client.db('doctorsPortal').collection('bookings');
        const usersCollection = client.db('doctorsPortal').collection('users');
        const doctorsCollection = client.db('doctorsPortal').collection('doctors');

        // NOTE: make sure you use verifyadmin after verifyJWT
        const verifyAdmin = async(req, res, next) => {
            const decodedEmail = req.decoded.email;
            const query = {email: decodedEmail};
            const user = await usersCollection.findOne(query);

            if(user?.role !== 'admin'){
                return res.status(403).send({message: 'Forbidden access'});
            }
            next();
        }

        // get appointmentOption data
        // Use Aggregate to query multiple collection and then merge dat
        app.get('/appointmentOptions', async(req, res) => {
            const date = req.query.date;
            const query = {};
            const options = await appointmentOptionCollection.find(query).toArray();
            
            // get bookings of the provided date
            const bookingQuery = { appointmentDate: date };
            const alreadyBooked = await bookingsCollection.find(bookingQuery).toArray();
            
            // code carefully
            options.forEach(option => {
                const optionBooked = alreadyBooked.filter(book => book.treatment === option.name);
                const bookedSlots = optionBooked.map(book => book.slot);
                const remainingSlots = option.slots.filter(slot => !bookedSlots.includes(slot))
                option.slots = remainingSlots;
            })
            res.send(options);
        });

        // version API
        app.get('/v2/appointmentOptions', async(req, res) => {
            const date = req.query.date;
            const options = await appointmentOptionCollection.aggregate([
                {
                    $lookup: {
                        from: 'bookings',
                        localField: 'name',
                        foreignField: 'treatment',
                        pipeline: [
                            {
                                $match: {
                                    $expr: {
                                        $eq: ['$appointmentDate', date]
                                    }
                                }
                            }
                        ],
                        as: 'booked'
                    }
                },
                {
                    $project: {
                        name: 1,
                        price: 1,
                        slots: 1,
                        booked: {
                            $map: {
                                input: '$booked',
                                as: 'book',
                                in: '$$book.slot'
                            }
                        }
                    }
                },
                {
                   $project: {
                    name: 1,
                    price: 1,
                    slots: {
                        $setDifference: ['$slots', '$booked']
                    }
                   } 
                },
            ]).toArray();
            res.send(options);
        });

        // get appointmentSpecialty (use project() method)
        app.get('/appointmentSpecialty', async(req, res) => {
            const query = {};
            const result = await appointmentOptionCollection.find(query).project({name: 1}).toArray();
            res.send(result);
        });

        /**
         * API Naming convention
         * app.get('/bookings')
         * app.get('/bookings/:id')
         * app.post('/bookings')
         * app.patch('/bookings/:id')
         * app.delere('/bookings/:id')
         */


        // get bookings data
        app.get('/bookings',  async(req, res) => {
            const email = req.query.email;
            // const decodedEmail = req.decoded.email;

            // if(email === decodedEmail){
            //     return res.status(403).send({message: 'Forbidden access'})
            // }

            const query = { email: email};
            const bookings = await bookingsCollection.find(query).toArray();
            res.send(bookings);
        });

        // get booking
        app.get('/bookings/:id', async(req, res) => {
            const id = req.params.id;
            const query = { _id: ObjectId(id)};
            const result = await bookingsCollection.findOne(query);
            res.send(result);
        })

        // post booking
        app.post('/bookings', async(req, res) => {
            const booking = req.body;
            const query = {
                appointmentDate: booking.appointmentDate,
                email: booking.email,
                treatment: booking.treatment
            }

            const alreadyBooked = await bookingsCollection.find(query).toArray();

            if(alreadyBooked.length){
                const message = `You already have a booking on ${booking.appointmentDate}`;
                return res.send({acknowledged: false, message});
            }
            const result = await bookingsCollection.insertOne(booking);
            res.send(result);
        });

        // Get jwt (user)
        app.get('/jwt', async(req, res) => {
            const email = req.query.email;
            const query = { email: email};
            const user = await usersCollection.findOne(query);
            
            if(user){
                const token = jwt.sign({email}, process.env.ACCESS_TOKEN, {expiresIn: '1h'});
                return res.send({accessToken: token});
            }
            res.status(403).send({accessToken: ''})
        })

        // get users
        app.get('/users', async(req, res) => {
            const query = {};
            const users = await usersCollection.find(query).toArray();
            res.send(users);
        });

        // get user
        app.get('/users/admin/:email', async(req, res) => {
            const email = req.params.email;
            const query = { email };
            const user = await usersCollection.findOne(query);
            res.send( {isAdmin: user?.role === 'admin'} );
        })


        // users create (post)
        app.post('/users', async(req, res) => {
            const user = req.body;
            const result = await usersCollection.insertOne(user);
            res.send(result);
        });


        // update user
        app.put('/users/admin/:id', verifyJWT, verifyAdmin, async(req, res) => {
            
            const id = req.params.id;
            const filter = { _id: ObjectId(id)};
            const options = { upsert: true};
            const updateDoc = {
                $set: {
                    role: 'admin'
                }
            }

            const result = await usersCollection.updateOne(filter, updateDoc, options);
            res.send(result);
        });

        // tepmorary to update price field on appointment options
        // app.get('/addPrice', async(req, res) => {
        //     const filter = {};
        //     const options = {upsert: true};
        //     const updateDoc = {
        //         $set: {
        //             price: 100
        //         }
        //     }
        //     const result = await appointmentOptionCollection.updateMany(filter, updateDoc, options);
        //     res.send(result);
        // })

        // get doctors
        app.get('/doctors', verifyJWT, verifyAdmin, async(req, res) => {
            const query = {};
            const doctors = await doctorsCollection.find(query).toArray();
            res.send(doctors);
        })

        // post doctor
        app.post('/doctors', verifyJWT, verifyAdmin, async(req, res) => {
            const doctor = req.body;
            const result = doctorsCollection.insertOne(doctor);
            res.send(result);
        });

        // doctor delete
        app.delete('/doctors/:id', verifyJWT, verifyAdmin, async(req, res) => {
            const id = req.params.id;
            const filter = {_id: ObjectId(id)};
            const result = await doctorsCollection.deleteOne(filter);
            res.send(result);
        })
    }
    finally{

    }
}

run().catch(err => console.log(err))


app.get('/', async(req, res) => {
    res.send('Doctors Portal server is Running.');
});

app.listen(port, () => console.log(`Doctors portal running on ${port}`));