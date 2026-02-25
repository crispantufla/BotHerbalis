const validate = (schema) => (req, res, next) => {
    try {
        schema.parse(req.body); // Si falla, lanza ZodError
        next();
    } catch (err) {
        return res.status(400).json({
            error: "Datos inválidos enviados desde el cliente",
            details: err.errors
        });
    }
};

module.exports = validate;
