import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json());

// Root folder থেকে index.html serve করবে
app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "index.html")
  );
});

// Static files root folder থেকে
app.use(
  express.static(__dirname)
);

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "iCoinGate Wallet"
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `iCoinGate Wallet running on port ${PORT}`
  );
});