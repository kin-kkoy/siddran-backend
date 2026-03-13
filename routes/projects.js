const express = require("express");
const router = express.Router();
const pool = require('../db/connection')
const checkAuth = require('../middleware/authMiddleware');
const { strictLimiter, contentUpdateLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger')

router.use(checkAuth);

// GET all projects
router.get('/', async (req, res) => {
    try {

    } catch (error) {

    }
});

// POST create a project
router.post('/', strictLimiter, async (req, res) => {
    try {

    } catch (error) {

    }
});

// PUT update a project
router.put('/:id', contentUpdateLimiter, async (req, res) => {
    try {

    } catch (error) {

    }
});

// DELETE a project
router.delete('/:id', strictLimiter, async (req, res) => {
    try {

    } catch (error) {

    }
});

// ----- PROJECT TASKS ROUTES -----

// POST add a task to a project
router.post('/:projectId/tasks', strictLimiter, async (req, res) => {
    try {

    } catch (error) {

    }
});

// PUT update a project task
router.put('/:projectId/tasks/:taskId', contentUpdateLimiter, async (req, res) => {
    try {

    } catch (error) {

    }
});

// DELETE a project task
router.delete('/:projectId/tasks/:taskId', strictLimiter, async (req, res) => {
    try {

    } catch (error) {

    }
});

module.exports = router;
