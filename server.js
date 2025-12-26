import express from "express";

const app = express();

/**
 * Cloud Run health check
 */
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

/**
 * Root test
 */
app.get("/", (req, res) => {
  res.send("Server is running");
});

/**
 * IMPORTANT: Cloud Run port handling
 */
const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
