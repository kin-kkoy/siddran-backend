const jwt = require('jsonwebtoken')

const checkAuth = (req, res, next) => {
    try {
        // flow: get header (returns a string) which contains token -> split the header string to get the token -> verify if token is correct -> if so, attach the payload (username, userID) to the request (not the body but the req object itself) -> call next()

        const header = req.headers.authorization;
        if(!header) return res.status(401).json({error: "Authorization header missing"}) 

        const token = header.split(' ')[1];
        if(!token) return res.status(401).json({error: "Token deformed"}) 
 
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        // no need for an if checker since it auto throws error if invalid/expired

        // attaching (we're creating a new property called `user`)
        req.user = payload;

        next();

    } catch (error) {
        console.error('Failed to verify token:', error.message);
        return res.status(401).json({error: "Invalid/expired token"})
    }
}

module.exports = checkAuth