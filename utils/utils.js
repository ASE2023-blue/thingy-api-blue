/**
 * All utilities functions used in the application.
 * @module utils
 */
const AppError = require('./classes/AppError');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { TWILIO_CLIENT } = require('./globals');
const { Server } = require('http');
const multer = require('multer');
const { promisify } = require('util');
const User = require('../models/userModel');

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

exports.checkLocation = coordinates => {
  if (coordinates?.length !== 2) return false;

  const [lat, lng] = coordinates;

  if (typeof lat !== 'number' && Math.abs(lat) > 90) return false;

  if (typeof lng !== 'number' && Math.abs(lng) > 180) return false;

  return true;
};

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

exports.connectUser = async token => {
  // 1) Verify the token : errors that can be thrown in the process and catched by catchAsync
  //  JSONWebTokenError : invalid token
  //  TokenExpiredError : the token has expired
  const decoded = await promisify(jwt.verify)(token, JWT_SECRET);

  // 2) Check if the user still exists
  const currentUser = await User.findById(decoded.id).select(
    '+role +passwordChangedAt +isConfirmed +isEmailConfirmed',
  );
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
