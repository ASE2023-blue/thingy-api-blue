/**
 * All utilities functions used in the application.
 * @module utils
 */
const AppError = require('./classes/AppError');

const { Point } = require('@influxdata/influxdb-client');
const { INFLUX } = require('./globals');
const { once } = require('events');

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { TWILIO_CLIENT } = require('./globals');
const { Server } = require('http');
const multer = require('multer');
const { promisify } = require('util');
const mqttClient = require('../mqtt/mqttHandler');

const {
  env: { TWILIO_PHONE_NUMBER, JWT_SECRET },
} = process;

/**
 * Function used to handle mongoose invalid requests generating CastError.
 * @param {mongoose.Error} error The error generated by the invalid operation on the database.
 * @returns {AppError} A CastError AppError object with a 400 status code.
 */
exports.queryByIdDB = error => {
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
exports.handleJWTError = () => new AppError('Invalid token!', 401);

/**
 * Function used to handler requests containing an invalid expired JWT authentication token.
 * @returns {AppError} An invalid JWT AppError object with a 401 status code.
 */
exports.handleJWTExpiredError = () =>
  new AppError('Your token has expired. Please log in again!', 401);

/**
 * Function used to handle the respone object returned to the client when the server is in dev mode.
 * @param {Error} error The error object for which we want to send a response.
 * @param {import('express').Response} res The response object of the Express framework, used to handle the response we will give back to the end user.
 */
exports.sendErrorDev = (error, res) => {
  const { statusCode, status, message, stack } = error;
  res.status(statusCode).json({ status, error, message, stack });
};

/**
 * Function used to handle the response object returned to the client when the server is in prod mode.
 * @param {Error} err the error object for which we want to send a response.
 * @param {import('express').Response} res the response object of the Express framework, used to handle the response we will give back to the end user.
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
    .json({ status: 'error', message: 'Something went wrong. Try Again!' });
};

/**
 * Function used to gracefully shut down the server in the case of a fatal unhandled error happening on it.
 * @param {Server} server The HTTP server we want to gracefully shut down.
 * @param {mongoose.Connection} dbConnection The opened mongoose db connection we want to shut down simultaneously as the server.
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
      result.push({
        device: rowObject.device,
        measurement: rowObject._measurement,
        property: rowObject._field,
        value: rowObject._value,
        time: rowObject._time,
      });
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

/**
 * Function used to generate a jwt authentication for an user.
 * @param {import('express').Request} req The request object of the Express framework, used to handle the request sent by the client.
 * @param {string} id the id of the user for whom we want to create a jwt authentication token.
 * @returns {Object} an object containing the response object that will be sent to the user and the cookie options for setting the jwt as httpOnly cookie.
 */
exports.createSendToken = (req, id) => {
  const token = jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  });

  const cookieOptions = {
    expires: new Date(
      Date.now() + process.env.JWT_COOKIE_EXPIRES_IN * 60 * 600 * 1000,
    ),
    httpOnly: true,
    sameSite: 'none',
    secure: req.secure || req.header('x-forwarded-proto') === 'https',
    domain: req.get('origin'),
  };

  return { resObject: { status: 'success', token }, cookieOptions };
};

/**
 * Function used to send a SMS to an user.
 * @param {User} user The user to whom we want to send a SMS.
 */
exports.sendPinCode = async user => {
  const [pinCode, pinCodeExpires] = user.createPinCode();
  await user.save({ validateBeforeSave: false });
  TWILIO_CLIENT.messages.create({
    from: TWILIO_PHONE_NUMBER,
    to: user.phone,
    body: `${pinCode}`,
  });

  return pinCodeExpires;
};

/**
 * Function used to generate a random token link that will be sent among an email.
 * @returns {string[]} The token that will be contained in the link and its hashed version that will be stored in the database.
 */
exports.createLinkToken = () => {
  const token = crypto.randomBytes(32).toString('hex');

  return [token, crypto.createHash('sha256').update(token).digest('hex')];
};

/**
 * Multer object used to store files into the file system when they are sent in a form.
 * @type {import('multer').Multer}
 */
exports.uploadImage = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, callback) => {
    const { mimetype } = file;
    if (mimetype.startsWith('image')) {
      callback(null, true);
      return;
    }
    callback(
      new AppError('Not an image!Please upload only images.', 400),
      false,
    );
  },
});

/**
 * Function used to check if a string expression corresponds to a boolean value.
 * @param {string} expr The expression in string format we want to check if it is a boolean value.
 * @returns {boolean} true if the expression is equal to true/false, false otherwise.
 */
exports.isBoolean = expr => {
  return expr === 'true' || expr === 'false';
};

/**
 * Function used to transform a string representation of true/false into his boolean value.
 * @param {string} expr The expression in stirng format we want to transform to a boolean value.
 * @returns {boolean} the boolean representation of the string format.
 */
exports.setBoolean = expr => {
  return expr.toLowerCase() === 'true' ? true : false;
};

/**
 * Function used to check the boolean validity of a field in a query parameter and throw an error if it is not the case.
 * @param {string} field The field value we want to check if it is a boolean.
 * @param {string} errMessage The error message returned by the route if the field value isn't a boolean.
 * @param {import('express').NextFunction} next The next function of the Express framework, used to handle the next middleware function passed to the express pipeline.
 * @returns {boolean} true if the field value corresponds to a boolean, false otherwise.
 */
exports.checkBoolean = (field, errMessage, next) => {
  if (!exports.isBoolean(field)) {
    next(new AppError(errMessage, 400));
    return false;
  }
  return true;
};

/**
 * Function used to check the numerical validity of a field in a query parameter and throw an error if it is not the case.
 * @param {string} field The field value we want to check if it is a number.
 * @param {string} errMessage The error message returned by the route if the field value isn't a boolean.
 * @param {import('express').NextFunction} next The next function of the Express framework, used to handle the next middleware function passed to the express pipeline.
 * @returns {boolean} true if the field value corresponds to a number, false otherwise.
 */
exports.checkNumber = (field, errMessage, next) => {
  if (isNaN(field)) {
    next(new AppError(errMessage, 400));
    return false;
  }
  return true;
};

/**
 *Function used to check the validity of the sent coordinates when creating a new parking.
 * @param {number[]} coordinates An array containing the latitude and the longitude of the parking
 * @returns {boolean} true if the coordinates are valid, false otherwise
 */
exports.checkLocation = coordinates => {
  if (coordinates?.length !== 2) return false;

  const [lat, lng] = coordinates;

  if (typeof lat !== 'number' && Math.abs(lat) > 90) return false;

  if (typeof lng !== 'number' && Math.abs(lng) > 180) return false;

  return true;
};

/**
 * Function used to query by id a model and retrieve the resulting document.
 * @param {mongoose.Model} Model the mongoose Model used to make the query to the database
 * @param {string} id the id of the resource we want to retrieve from the database
 * @param {Object} queryObj the query object, used to filter the retrieved resource with certain matching conditions
 * @param {Object} popObj the populate object, used to populate the reference fields in the model
 * @param {string} selectParams the list of fields we want to include in the finding of the requests
 * @returns {mongoose.Document} the resulting document of the querying process
 */
exports.queryById = async (
  Model,
  id,
  queryObj = {},
  popObj = {},
  selectParams = '',
) => {
  try {
    let query = Model.find({ _id: id, ...queryObj });
    if (selectParams !== '') query = query.select(selectParams);
    if (popObj && Object.keys(popObj).length !== 0)
      query = query.populate(popObj);
    const [document] = await query;
    return document;
  } catch (err) {
    if (err.name === 'CastError') return null;

    throw err;
  }
};

/**
 * Function used to retrieve the jwt token sent by an user when accessing an endpoint on the server.
 * @param {import('express').Request} req
 * @returns {string} the jwt token of the user making the request to an endpoint.
 */
exports.getToken = req => {
  const {
    headers: { authorization },
    cookies: { jwt: cookieToken },
  } = req;

  let token = '';

  if (authorization && authorization.startsWith('Bearer'))
    token = authorization.split(' ')[1];
  else if (cookieToken) token = cookieToken;

  return token;
};

/**
 * Function used to verify the jwt token sent by an user and authenticate him if it is valid.
 * @param {mongoose.Model<User>} userModel the user model from which we want to query the decoded jwt token and authentify
 * @param {string} token the jwt token we want to verify
 * @returns {mongoose.Document<User>} the document representing the user in the database if the checking process is valid
 */
exports.connectUser = async (userModel, token) => {
  // 1) Verify the token : errors that can be thrown in the process and catched by catchAsync
  //  JSONWebTokenError : invalid token
  //  TokenExpiredError : the token has expired
  const decoded = await promisify(jwt.verify)(token, JWT_SECRET);

  // 2) Check if the user still exists
  const currentUser = await userModel
    .findById(decoded.id)
    .select('+role +passwordChangedAt +isConfirmed +isEmailConfirmed');
  if (!currentUser)
    throw new AppError(
      "The requested account doesn't exist or was deleted.",
      401,
    );

  // 3) Check if the user has changed password after the token was issued
  if (currentUser.changedPasswordAfter(decoded.iat))
    throw new AppError(
      'User recently changed password! Please log in again.',
      401,
    );

  return currentUser;
};

/**
 * Asynchronous function used to wait for the user to click on a thingy within a timebound of 60 seconds.
 * @param {*} mqttClient
 * @param {string} thingy the id of the thingy from which we want to wait that the user clicks on its button
 * @returns {Promise<number>} a promise that resolves if the user clicks on the thingy within a delay of 60 seconds.
 */
exports.waitClickButton = async (mqttClient, thingy) => {
  return new Promise((resolve, reject) => {
    // Define a callback function to handle the 'message' event
    const messageHandler = (topic, message) => {
      try {
        const data = JSON.parse(message);
        const topicParts = topic.split('/');
        const thingsIndex = topicParts.indexOf('things');

        if (thingsIndex !== -1 && thingsIndex + 1 < topicParts.length) {
          const device = topicParts[thingsIndex + 1];

          if (device === thingy && data.appId === 'BUTTON') {
            // Remove the listener and resolve the promise
            mqttClient.off('message', messageHandler);
            resolve(data.ts);
          }
        }
      } catch (error) {
        // Handle JSON parsing error
        reject(error);
      }
    };

    // Attach the message handler to the 'message' event
    mqttClient.on('message', messageHandler);

    // Use 'once' to wait for the first 'message' event and set a timeout
    const timeoutId = setTimeout(() => {
      // Remove the listener and reject the promise on timeout
      mqttClient.off('message', messageHandler);
      reject(new AppError('Timeout waiting for button click expired.', 408));
    }, 60 * 1000); // Timeout set to 60 seconds (adjust as needed)

    // Use 'once' to wait for the first 'message' event
    once(mqttClient, 'message').then(() => {
      // Clear the timeout since the event occurred
      clearTimeout(timeoutId);
    });
  });
};

/**
 * Handles the calculation of an S-curve rating based on a given value and configuration.
 * @param {number} value - The value for which to calculate the rating.
 * @param {object} config - Configuration object.
 * @param {number[]} config.optimalRange - An array representing the optimal range [lower bound, upper bound].
 * @param {number} config.slopeAboveOptimal - Slope for the S-curve decay above the optimal range.
 * @param {number} config.slopeBelowOptimal - Slope for the S-curve decay below the optimal range.
 * @returns {number} - A normalized 5-star rating rounded to the nearest decimal.
 */
exports.getSCurveRating = (value, config) => {
  const { optimalRange, slopeAboveOptimal, slopeBelowOptimal } = config;

  // Calculate the distance from the optimal range bounds
  const distanceAbove = Math.max(0, value - optimalRange[1]); // Distance above the upper bound
  const distanceBelow = Math.max(0, optimalRange[0] - value); // Distance below the lower bound

  // Choose the maximum distance for the S-curve decay calculation
  const distance = Math.max(distanceAbove, distanceBelow);

  // Apply the S-curve decay formula with different slopes for above and below optimal range
  const slope =
    value >= optimalRange[0] && value <= optimalRange[1]
      ? 0
      : value > optimalRange[1]
      ? slopeAboveOptimal
      : slopeBelowOptimal;

  const rating = 2 / (1 + Math.exp(slope * distance));

  // Normalize the rating to a 5-star scale
  const normalizedRating = rating * 5;

  // Round the rating to the nearest decimal for clarity
  return normalizedRating;
};

/**
 * Handles the calculation of a linear rating based on a given value and configuration.
 * @param {number} value - The value for which to calculate the rating.
 * @param {object} config - Configuration object.
 * @param {number[]} config.optimalRange - An array representing the optimal range [lower bound, upper bound].
 * @param {number[]} config.fullRange - An array representing the full range [lower bound, upper bound].
 * @returns {number} - A 5-star rating for values within the optimal range. A linear decay rating for values outside the optimal range.
 */
exports.getLinearRating = (value, config) => {
  const { optimalRange, fullRange } = config;

  // Ensure the ranges are valid
  if (optimalRange[0] < fullRange[0] || optimalRange[1] > fullRange[1]) {
    new AppError('Invalid range specifications.', 400);
    return null;
  }

  // Check if the value is within the optimal range
  if (value >= optimalRange[0] && value <= optimalRange[1]) {
    return 5; // 5-star rating for values within the optimal range
  } else {
    const distanceAbove = Math.max(0, value - optimalRange[1]); // Distance above the upper bound
    const distanceBelow = Math.max(0, optimalRange[0] - value); // Distance below the lower bound
    const distance = Math.max(distanceAbove, distanceBelow);

    const fullRangeWidth = Math.abs(fullRange[0] - fullRange[1]);
    const optimalRangeWidth = Math.abs(optimalRange[0] - optimalRange[1]);

    // Normalize the distance to a 0-1 scale based on the full range
    const normalizedDistance =
      distance / ((fullRangeWidth - optimalRangeWidth) / 2);

    // Calculate the linear decay rating outside the optimal range
    const rating = 5 - 5 * normalizedDistance;

    // Ensure the rating is not below 0
    return Math.max(0, rating);
  }
};
