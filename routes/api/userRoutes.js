/**
 * User resource router of the REST API.
 * @module userRoutes
 */
const {
  signin,
  signup,
  confirmPin,
} = require('../../controllers/authController');
const { Router } = require('express');
const { getAllUsers } = require('../../controllers/userController');

/**
 * The User resource router.
 * @typedef {Router}
 */
const router = Router();

/**
 * @swagger
 * components:
 *   schemas:
 *     User:
 *       type: object
 *       properties:
 *         _id:
 *           type: string
 *           description: The id of the user
 *           example: 642c38f3b7ed1dbd25858e9e
 *         username:
 *           type: string
 *           description: The username of the user
 *           example: johndoe27
 */

/**
 * @swagger
 * /users:
 *   get:
 *     tags:
 *       - User
 *     summary: Route used to get all the users (students and teachers) in the application
 *     responses:
 *       200:
 *         description: List of all users
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   type: object
 *                   properties:
 *                     users:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/User'
 */
router.route('/').get(getAllUsers);

router.route('/signup').post(signup);

router.route('/signin').post(signin);

router.route('/confirm-pin').post(confirmPin);

module.exports = router;