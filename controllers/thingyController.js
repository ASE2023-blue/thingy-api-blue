/**
 * Functions related to calling the thingy resource in the API
 * @module thingyController
 */
const { catchAsync } = require('../utils/utils');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');
const axios = require('axios');

class Influx {
  constructor(orgName, bucketName, batchOptions) {
    this.orgName = orgName;
    this.bucketName = bucketName;
    this.batchOptions = batchOptions;
    this.client = new InfluxDB({
      url: process.env.INFLUX_URL,
      token: process.env.INFLUX_TOKEN,
    });
    this.queryClient = this.client.getQueryApi(this.orgName);
    this.writeClient = this.client.getWriteApi(
      this.orgName,
      this.bucketName,
      'ms',
      this.batchOptions,
    );
  }

  async getRetentionPolicy() {
    try {
      const response = await axios.get('http://localhost:8086/api/v2/buckets', {
        headers: {
          Authorization: `Token ${process.env.INFLUX_TOKEN}`,
        },
      });

      const buckets = response.data.buckets;

      if (buckets && buckets.length > 0) {
        const pnsBucket = buckets.find(bucket => bucket.name === 'pnsBucket');
        const retentionRule = pnsBucket.retentionRules[0];

        if (retentionRule && retentionRule.type === 'expire') {
          const seconds = retentionRule.everySeconds;
          const unit = seconds >= 86400 ? 'd' : 'h'; // Adjust as needed

          const value = unit === 'd' ? seconds / 86400 : seconds / 3600;
          return { value, unit };
        }
      }

      // Return a default value or handle the case where no bucket or retention rule is found
      return { value: 0, unit: 'h' };
    } catch (error) {
      console.error('Error fetching buckets:', error);
      // Handle the error or return a default value
      return { value: 0, unit: 'h' };
    }
  }
}

// Usage example:
const influx = new Influx('pnsOrg', 'pnsBucket', {
  flushInterval: 1000,
  batchSize: 10,
});

// Example of calling getRetentionPolicy
influx.getRetentionPolicy().then(retentionPolicy => {
  console.log('RetentionPolicy:', JSON.stringify(retentionPolicy, null, 2));
});

const thingDescription = {
  id: 'https://127.0.0.1/things/thingy91',
  title: 'Nordic Thingy:91',
  description: 'A WoT-connected Thingy:91 sensor',
  properties: {
    TEMP: {
      title: 'Temperature',
      type: 'number',
      unit: 'degree celsius',
      readOnly: true,
      description: 'A measurement of ambient temperature',
      links: [{ href: '/things/thingy91/properties/TEMP' }],
    },
    HUMID: {
      title: 'Humidity',
      type: 'number',
      unit: 'percent',
      readOnly: true,
      description: 'A measurement of ambient humidity',
      links: [{ href: '/things/thingy91/properties/HUMID' }],
    },
    AIR_PRESS: {
      title: 'Air Pressure',
      type: 'number',
      unit: 'kPa',
      readOnly: true,
      description: 'A measurement of ambient air pressure',
      links: [{ href: '/things/thingy91/properties/AIR_PRESS' }],
    },
    AIR_QUAL: {
      title: 'Air Quality',
      type: 'number',
      unit: 'AQI',
      readOnly: true,
      description: 'A measurement of ambient air quality',
      links: [{ href: '/things/thingy91/properties/AIR_QUAL' }],
    },
    CO2_EQUIV: {
      title: 'CO2 Equivalent',
      type: 'number',
      unit: 'MMTCDE',
      readOnly: true,
      description: 'A measurement of ambient CO2 equivalent',
      links: [{ href: '/things/thingy91/properties/CO2_EQUIV' }],
    },

    events: {
      flip: {
        title: 'Flip',
        type: 'string',
        readOnly: true,
        description: 'The Thingy has been flipped to a different side',
      },
      button: {
        title: 'Button',
        type: 'boolean',
        readOnly: true,
        description: 'The button has been pressed or released',
      },
    },
  },
};

function publishToMQTT(mqttClient, topic, message, res) {
  mqttClient.publish(topic, message, error => {
    if (error) {
      console.error(`Error publishing message: ${message} -> ${error}`);
    } else {
      console.log('Successfully published the following message: ', message);
      res.status(200).json({
        status: 'success',
        data: { message },
      });
    }
  });
}

function sendQueryResults(res, fluxQuery) {
  const result = [];

  influx.queryClient.queryRows(fluxQuery, {
    next: (row, tableMeta) => {
      const rowObject = tableMeta.toObject(row);
      result.push(rowObject);
    },
    error: error => {
      res.status(500).json({
        status: 'error',
        message: `An error occurred while fetching data: ${error}`,
      });
    },
    complete: () => {
      res.status(200).json({
        status: 'success',
        data: result,
      });
    },
  });
}

function getQueryRows(fluxQuery) {
  return new Promise((resolve, reject) => {
    let result = [];

    influx.queryClient.queryRows(fluxQuery, {
      next: (row, tableMeta) => {
        const rowObject = tableMeta.toObject(row);
        result.push(rowObject);
      },
      error: error => {
        reject(`An error occurred while fetching data: ${error}`);
      },
      complete: () => {
        resolve(result);
      },
    });
  });
}

exports.getButtonTimer = catchAsync(async (req, res, next) => {
  const getLastTwoRowsQuery = `from(bucket: "pnsBucket")
  |> range(start: -1d)
  |> filter(fn: (r) => r._measurement == "thingy91" and r._field == "BUTTON" and r._value == 0)
  |> sort(columns: ["_time"], desc: true)
  |> limit(n: 2)`;

  const getCountQuery = `from(bucket: "pnsBucket")
  |> range(start: -1d)
  |> filter(fn: (r) => r._measurement == "thingy91" and r._field == "BUTTON")
  |> group(columns: ["_field"])
  |> count()`;

  let rows = [];
  let countResult = [];

  try {
    rows = await getQueryRows(getLastTwoRowsQuery);
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: `Oops, something went wrong with the following query: ${getLastTwoRowsQuery}`,
    });
    return;
  }

  try {
    countResult = await getQueryRows(getCountQuery);
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: `Oops, something went wrong with the following query: ${getCountQuery}`,
    });
    return;
  }

  const count = countResult[0]._value; // Length of the count result

  if (count === 0) {
    console.log('No rows matched');
  } else if ((count / 2) % 2 === 0) {
    // Handle the case when the count is even (returning two last rows)
    console.log('The number of rows is even and equals: ', count / 2); // rows will contain the last two rows
  } else {
    // Handle the case when the count is odd (returning one last row)
    console.log('The number of rows is odd and equals: ', count / 2); // rows will contain the last row
    if (rows.length == 2) {
      rows = [rows[1]];
    }
  }

  console.log(rows.length);

  if (!rows) {
    res.status(200).json({
      status: 'fail',
      errorMessage: 'No timer has been starter for the last 24h',
      data: [],
    });
  } else if (rows.length >= 1) {
    let time1 = new Date(rows[0]._time);
    let time2 = new Date();
    if (rows.length == 2) {
      time2 = new Date(rows[0]._time);
      time1 = new Date(rows[1]._time);
    }

    const timeDifference = time2 - time1;

    const days = Math.floor(timeDifference / 86400000); // 1 day = 24 hours * 60 minutes * 60 seconds * 1000 milliseconds
    const remainingTime = timeDifference % 86400000; // Remaining time in milliseconds

    const hours = Math.floor(remainingTime / 3600000); // 1 hour = 60 minutes * 60 seconds * 1000 milliseconds
    const minutes = Math.floor((remainingTime % 3600000) / 60000); // 1 minute = 60 seconds * 1000 milliseconds
    const seconds = ((remainingTime % 3600000) % 60000) / 1000;

    const timerObject = {
      days: days,
      hours: hours,
      minutes: minutes,
      seconds: seconds.toFixed(0),
    };

    const timer = `${days}d ${hours}h ${minutes}m ${seconds.toFixed(0)}s`;

    console.log(timer); // Output: "0h 0m 0.180s"

    res.status(200).json({
      status: 'success',
      data: timerObject,
    });
  } else {
    res.status(200).json({
      status: 'error',
      errorMessage: 'Oops, something went wrong while computing timer data',
      data: [],
    });
  }
});

function constructBasicPropertyQuery(bucket, interval, measurement, field) {
  return `from(bucket: "${bucket}")
  |> range(start: -${interval})
  |> filter(fn: (r) => r._measurement == "${measurement}" and r._field == "${field}")`;
}

function constructStatisticalQueryOnProperty(
  bucket,
  interval,
  measurement,
  field,
  statistic,
) {
  return `from(bucket: "${bucket}")
  |> range(start: -${interval})
  |> filter(fn: (r) => r._measurement == "${measurement}" and r._field == "${field}")
  |> group(columns: ["_field"])
  |> ${statistic}()`;
}

exports.getThingDescription = catchAsync(async (req, res, next) => {
  res.status(200).json({
    status: 'success',
    data: { thingDescription },
  });
});

exports.getProperty = catchAsync(async (req, res, next) => {
  const interval = req.query.interval || '30m'; // Default interval is 30min
  const property = req.params.property;
  let fluxQuery = constructBasicPropertyQuery(
    'pnsBucket',
    interval,
    'thingy91',
    property,
  );
  sendQueryResults(res, fluxQuery);
});

exports.getStatisticOfProperty = catchAsync(async (req, res, next) => {
  const interval = req.query.interval || '1h'; // Default interval is 1h
  const property = req.params.property;
  const statistic = req.params.statistic;
  let fluxQuery = constructStatisticalQueryOnProperty(
    'pnsBucket',
    interval,
    'thingy91',
    property,
    statistic,
  );
  sendQueryResults(res, fluxQuery);
});

exports.addFloatProperty = async message => {
  let point = new Point('thingy91')
    .floatField(message.appId, message.data)
    .timestamp(new Date().getTime());

  influx.writeClient.writePoint(point);
};

exports.addIntegerProperty = async message => {
  let point = new Point('thingy91')
    .intField(message.appId, message.data)
    .timestamp(new Date().getTime());

  influx.writeClient.writePoint(point);
};

exports.setBuzzer = catchAsync(async (req, res, next) => {
  const mqttClient = require('./mqttHandler');
  let freq = +req.query.freq || 1000;
  const setting = req.params.setting;
  const topic = 'things/blue-1/shadow/update/accepted';

  if (setting == 'off') {
    freq = 0;
  }

  const message = JSON.stringify({
    appId: 'BUZZER',
    data: { frequency: freq },
    messageType: 'CFG_SET',
  });

  publishToMQTT(mqttClient, topic, message, res);
});

exports.setLEDColor = catchAsync(async (req, res, next) => {
  const mqttClient = require('./mqttHandler');
  let colorToBeSet = req.params.color || 'red';
  const topic = 'things/blue-1/shadow/update/accepted';

  if (colorToBeSet == 'blue') {
    colorToBeSet = '0000ff';
  } else if (colorToBeSet == 'green') {
    colorToBeSet = '00ff00';
  } else {
    colorToBeSet = 'ff0000';
  }

  const message = JSON.stringify({
    appId: 'LED',
    data: { color: colorToBeSet },
    messageType: 'CFG_SET',
  });

  publishToMQTT(mqttClient, topic, message, res);
});