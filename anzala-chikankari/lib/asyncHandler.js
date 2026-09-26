// Wraps an async Express handler so a rejected promise reaches the error middleware instead of hanging
// the request (Express 4 doesn't do this for you).
module.exports = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
