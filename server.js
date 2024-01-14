const express = require('express');
const mysql = require('mysql');
const dotenv = require('dotenv')
const bodyParser = require('body-parser');
const cors = require('cors');
dotenv.config();
const app = express();
const port = 3001;
// Database connection configuration
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE
});
// Connect to the database
db.connect((err) => {
  if (err) throw err;
  console.log('Connected to the MySQL database');
});
app.use(bodyParser.json());

const allowedOrigins = ['https://yueksel.me', 'https://home.yueksel.me', 'http://localhost:3000','http://localhost:443'];
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
};
app.use(cors(corsOptions));
// app.use(cors())

app.get('/api/ids', (req, res) => {
  const query = 'SELECT id FROM users';
  db.query(query, (err, results) => {
    if (err) {
      res.status(500).send('Error fetching user IDs');
    } else {
      res.status(200).json(results.map(row => row.id));
    }
  });
});
app.get('/api/users/:id', (req, res) => {
  const { id } = req.params;
  const query = 'SELECT * FROM users WHERE id = ?';
  db.query(query, [id], (err, result) => {
    if (err) {
      res.status(500).send('Error fetching user');
    } else {
      res.status(200).json(result);
    }
  });
});
app.post('/api/users', (req, res) => {
  const { username, apiurl, password, longitude, latitude, homename, sensors } = req.body;
  if (!username || !apiurl || !password || !longitude || !latitude || !homename) {
    return res.status(400).send('Missing required fields');
  }
  const query = 'INSERT INTO users (username, apiurl, password, longitude, latitude, homename, sensors) VALUES (?, ?, ?, ?, ?, ?, ?)';
  db.query(query, [username, apiurl, password, longitude, latitude, homename, sensors], (err, result) => {
    if (err) {
      res.status(500).send('Error creating new user');
    } else {
      res.status(201).send('User created successfully');
    }
  });
});
app.put('/api/users/:id', (req, res) => {
  const { id } = req.params;
  const { username, apiurl, password, longitude, latitude, homename, sensors } = req.body;
  const query = 'UPDATE users SET username = ?, apiurl = ?, password = ?, longitude = ?, latitude = ?, homename = ?, sensors = ? WHERE id = ?';
  db.query(query, [username, apiurl, password, longitude, latitude, homename, sensors, id], (err, result) => {
    if (err) {
      res.status(500).send('Error updating user');
    } else {
      res.status(200).send('User updated successfully');
    }
  });
});
app.delete('/api/users/:id', (req, res) => {
  const { id } = req.params;
  const query = 'DELETE FROM users WHERE id = ?';
  db.query(query, [id], (err, result) => {
    if (err) {
      res.status(500).send('Error deleting user');
    } else {
      res.status(200).send('User deleted successfully');
    }
  });
});
const parseSensors = (sensorsString) => {
  const sensorsArray = sensorsString.split(',');
  const sensors = {};
  sensorsArray.forEach(sensor => {
    const [key, value] = sensor.split(':').map(s => s.trim().replace(/"/g, ''));
    sensors[key] = value;
  });
  return sensors;
};
// Endpoint to fetch live data for sensors from Home Assistant
app.get('/api/smarthome/:id', (req, res) => {
  const { id } = req.params;
  // Fetch the user's Home Assistant API URL, access token, and sensors from the database
  const userQuery = 'SELECT apiurl, password, sensors FROM users WHERE id = ?';
  db.query(userQuery, [id], (err, userResult) => {
    if (err) {
      return res.status(500).send('Error fetching user data');
    }
    const { apiurl, password, sensors } = userResult[0];
    const parsedSensors = parseSensors(sensors);
    const headers = {
      'Authorization': 'Bearer ' + password,
      'Content-Type': 'application/json',
    };
    // Fetch data for each sensor and aggregate results
    const sensorDataPromises = Object.entries(parsedSensors).map(([sensorName, entity_id]) => {
      const haUrl = `${apiurl}states/${entity_id}`;
      return fetch(haUrl, { headers: headers })
        .then(response => response.json())
        .then(data => ({ sensorName, data: data.state }))
        .catch(err => ({ sensorName, error: 'Error fetching data' }));
    });
    Promise.all(sensorDataPromises)
      .then(results => {
        res.status(200).json(results);
      })
      .catch(err => {
        res.status(500).send('Error fetching sensor data');
      });
  });
});
const fetchSensorData = async (apiurl, password, sensorName, entity_id) => {
  const headers = {
    'Authorization': 'Bearer ' + password,
    'Content-Type': 'application/json',
  };
  const haUrl = `${apiurl}states/${entity_id}`;
  try {
    const response = await fetch(haUrl, { headers: headers });
    if (!response.ok) {
      console.error(`Error fetching sensor data for ${sensorName}:`, await response.text());
      return { sensorName, sensordata: null };
    }
    const data = await response.json();
    return { sensorName, sensordata: data.state };
  } catch (err) {
    console.error(`Error fetching sensor data for ${sensorName}:`, err);
    return { sensorName, sensordata: null };
  }
};
app.get('/api/markers', async (req, res) => {
  const query = 'SELECT id, longitude, latitude, homename, apiurl, password, sensors FROM users';
  db.query(query, async (err, results) => {
    if (err) {
      return res.status(500).send('Error fetching marker data');
    }
    // Fetch sensor data for each marker using Home Assistant API
    const markersPromises = results.map(async (user) => {
      const { longitude, latitude, homename, apiurl, password, sensors } = user;
      const parsedSensors = parseSensors(sensors);
      const sensorDataPromises = Object.entries(parsedSensors).map(([sensorName, entity_id]) =>
        fetchSensorData(apiurl, password, sensorName, entity_id)
      );
      const sensorsWithData = await Promise.all(sensorDataPromises);
      return {
        long: longitude,
        lat: latitude,
        homename,
        sensors: sensorsWithData
      };
    });
    const markers = await Promise.all(markersPromises);
    res.status(200).json(markers);
  });
});
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
