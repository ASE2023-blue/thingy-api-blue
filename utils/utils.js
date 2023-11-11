/**
 * All utilities functions used in the application.
 * @module utils
 */
const { Server } = require('http');
const { Connection } = require('mongoose');
const mongoose = require('mongoose');
const { Response } = require('express');
const AppError = require('./classes/AppError');
const { Point } = require('@influxdata/influxdb-client');
const { INFLUX } = require('./globals');

/**
 * Function used to handle mongoose invalid requests generating CastError.
 * @param {mongoose.Error} error The error generated by the invalid operation on the database.
 * @returns {AppError} A CastError AppError object with a 400 status code.
 */
exports.handleCastErrorDB = error => {
  const message = `Invalid ${error.path}: ${error.value}`;
  return new AppError(message, 400);
};

/**
 * Function used to handle mongoose duplicate field database errors.
 * @param {mongoose.Error} error The error generated by the invalid operation on the database.
 * @returns {AppError} A duplicate field AppError object with a 400 status code.
 */
exports.handleDuplicateFieldsDB = error => {
  const [value] = error.errmsg.match(/(["'])(?:(?=(\\?))\2.)*?\1/);

  const message = `Duplicate field value: ${value}. Please use another value!`;

  return new AppError(message, 400);
};

/**
 * Function used to handle mongoose validation database errors.
 * @param {mongoose.Error} error The error generated by the invalid operation on the database.
 * @returns {AppError} A validation AppError object with a 400 status code.
 */
exports.handleValidationErrorDB = error => {
  const message = `Invalid input data.`;
  const errors = Object.entries(error.errors).map(([key, value]) => ({
    [key]: value.message,
  }));

  const appError = new AppError(message, 400);
  appError.fields = errors;
  return appError;
};

/**
 * Function used to handle requests containing an invalid JWT authentication token.
 * @returns {AppError} An invalid JWT AppError object with a 401 status code.
 */
exports.handleJWTError = () =>
  new AppError('Invalid token. Please log in again!', 401);

/**
 * Function used to handler requests containing an invalid expired JWT authentication token.
 * @returns {AppError} An invalid JWT AppError object with a 401 status code.
 */
exports.handleJWTExpiredError = () =>
  new AppError('Your token has expired. Please log in again!', 401);

/**
 * Function used to handle the respone object returned to the client when the server is in dev mode.
 * @param {Error} error The error object for which we want to send a response.
 * @param {Response} res The response object of the Express framework, used to handle the response we will give back to the end user.
 */
exports.sendErrorDev = (error, res) => {
  const { statusCode, status, message, stack } = error;
  res.status(statusCode).json({ status, error, message, stack });
};

/**
 * Function used to handle the response object returned to the client when the server is in prod mode.
 * @param {Error} err the error object for which we want to send a response.
 * @param {Response} res the response object of the Express framework, used to handle the response we will give back to the end user.
 */
exports.sendErrorProd = (err, res) => {
  if (err.isOperational) {
    const { statusCode, status, message, fields } = err;
    res.status(statusCode).json({ status, message, fields });
    return;
  }
  // Log error
  console.error('ERROR: ', err);

  // Send generic message
  res
    .status(500)
    .json({ status: 'error', message: 'Something went wrong. Try Again !' });
};

/**
 * Function used to gracefully shut down the server in the case of a fatal unhandled error happening on it.
 * @param {Server} server The HTTP server we want to gracefully shut down.
 * @param {Connection} dbConnection The opened mongoose db connection we want to shut down simultaneously as the server.
 * @param {string} message The error message we want to display when we shut down the server.
 * @param {Error} error The unhandled error that has caused the server to crash.
 */
exports.shutDownAll = async (server, dbConnection, message, error) => {
  try {
    console.log(message);
    if (error) console.error(error.name, error.message);
    if (dbConnection) {
      console.log('Close DB connection.');
      await dbConnection.close();
    }

    if (server)
      server.close(() => {
        console.log('Close server.');
        process.exit(1);
      });
    else process.exit(1);
  } catch (err) {
    console.error(err.name, err.message);
    process.exit(1);
  }
};

/**
 * Function used to handle errors generated in controllers function and redirect them to the Error handling NextFunction in the case where it happens.
 * @param {Function} fn the async controller function for which we want to catch the errors and handle the response in the route.
 */
exports.catchAsync = fn => (req, res, next) => {
  fn(req, res, next).catch(err => next(err));
};

/**
 * Publishes a message to an MQTT topic and sends a response.
 * @param {import('mqtt').Client} mqttClient - The MQTT client to publish the message.
 * @param {string} topic - The MQTT topic to which the message will be published.
 * @param {string} message - The message to publish.
 * @param {import('express').Response} res - The response object to send a status back to the client.
 * @function
 */
exports.publishToMQTT = (mqttClient, topic, message, res) => {
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
};

/**
 * Sends query results from InfluxDB to the client.
 * @param {import('express').Response} res - The response object to send data back to the client.
 * @param {string} fluxQuery - The Flux query to execute.
 * @function
 */
exports.sendQueryResults = (res, fluxQuery) => {
  const result = [];

  INFLUX.queryClient.queryRows(fluxQuery, {
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
};

/**
 * Retrieves query rows from InfluxDB as a promise.
 * @param {string} fluxQuery - The Flux query to execute.
 * @returns {Promise<Array>} A promise that resolves to an array of query results.
 * @function
 */
exports.getQueryRows = fluxQuery => {
  return new Promise((resolve, reject) => {
    let result = [];

    INFLUX.queryClient.queryRows(fluxQuery, {
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
};

/**
 * Adds a float property to the InfluxDB with the tag corresponding to the deviceId.
 * @param {Object} message - The MQTT message containing the property information.
 * @function
 */
exports.addFloatProperty = async (deviceId, message) => {
  let point = new Point('thingy91')
    .tag('device', deviceId)
    .floatField(message.appId, message.data)
    .timestamp(new Date().getTime());

  INFLUX.writeClient.writePoint(point);
};

/**
 * Adds an integer property to the InfluxDB with the tag corresponding to the deviceId.
 * @param {Object} message - The MQTT message containing the property information.
 * @function
 */
exports.addIntegerProperty = async (deviceId, message) => {
  if (message.data == '1') {
    let point = new Point('thingy91')
      .tag('device', deviceId)
      .intField(message.appId, message.data)
      .timestamp(new Date().getTime());

    INFLUX.writeClient.writePoint(point);
    console.log(
      `Added to tag ${deviceId} the following data: `,
      JSON.stringify(message, null, 2),
    );
  }
};

/**
 * Constructs a basic Flux query for retrieving property data from InfluxDB.
 * @param {string} bucket - The InfluxDB bucket.
 * @param {string} interval - The time interval for the query.
 * @param {string} measurement - The measurement (e.g., 'thingy91').
 * @param {string} deviceId - The device ID to filter data by.
 * @param {string} field - The field (e.g., 'TEMP').
 * @returns {string} The constructed Flux query.
 * @function
 */
exports.constructBasicPropertyQuery = (
  bucket,
  interval,
  measurement,
  deviceId,
  field,
) => {
  return `from(bucket: "${bucket}")
  |> range(start: -${interval})
  |> filter(fn: (r) => r._measurement == "${measurement}" and r._field == "${field}" and r.device == "${deviceId}")`;
};

/**
 * Constructs a statistical Flux query for property data from InfluxDB.
 * @param {string} bucket - The InfluxDB bucket.
 * @param {string} interval - The time interval for the query.
 * @param {string} measurement - The measurement (e.g., 'thingy91').
 * @param {string} deviceId - The device ID to filter data by.
 * @param {string} field - The field (e.g., 'TEMP').
 * @param {string} statistic - The statistical function (e.g., 'mean' 'stddev').
 * @returns {string} The constructed Flux query.
 * @function
 */
exports.constructStatisticalQueryOnProperty = (
  bucket,
  interval,
  measurement,
  deviceId,
  field,
  statistic,
) => {
  return `from(bucket: "${bucket}")
  |> range(start: -${interval})
  |> filter(fn: (r) => r._measurement == "${measurement}" and r._field == "${field}" and r.device == "${deviceId}")
  |> group(columns: ["_field"])
  |> ${statistic}()`;
};
