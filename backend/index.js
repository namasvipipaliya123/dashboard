const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const PDFDocument = require("pdfkit");
require("pdfkit-table");
require("dotenv").config();
const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({
  origin :"https://dashboard-rho-woad-52.vercel.app/",
  methods :["GET","POST","PUT","DELETE"],
  credentials: true
}));
app.use(cors({
  origin : "*"
}))
app.use(express.json());
const upload = multer({ dest: "uploads/" });

let latestData = null;
const statusList = [
  "all",
  "rto",
  "door_step_exchanged",
  "delivered",
  "cancelled",
  "ready_to_ship",
  "shipped",
  "supplier_listed_price",
  "supplier_discounted_price",
];

function parsePrice(value) {
  if (!value) return 0;
  const clean = value.toString().trim().replace(/[^0-9.\-]/g, "");
  return parseFloat(clean) || 0;
}

function getColumnValue(row, possibleNames) {
  const keys = Object.keys(row).map((k) => k.toLowerCase().trim());
  for (let name of possibleNames) {
    const idx = keys.indexOf(name.toLowerCase().trim());
    if (idx !== -1) return row[Object.keys(row)[idx]];
  }
  return 0;
}

function categorizeRows(rows) {
  const categories = {};
  statusList.forEach((status) => (categories[status] = []));
  categories.other = [];

  let totalSupplierListedPrice = 0;
  let totalSupplierDiscountedPrice = 0;
  let sellInMonthProducts = 0;
  let deliveredSupplierDiscountedPriceTotal = 0;
  let totalDoorStepExchanger = 0;

  rows.forEach((row) => {
    const status = (row["Reason for Credit Entry"] || "").toLowerCase().trim();
    categories["all"].push(row);

    const listedPrice = parsePrice(
      getColumnValue(row, [
        "Supplier Listed Price (Incl. GST + Commission)",
        "Supplier Listed Price",
        "Listed Price",
      ])
    );

    const discountedPrice = parsePrice(
      getColumnValue(row, [
        "Supplier Discounted Price (Incl GST and Commission)",
        "Supplier Discounted Price (Incl GST and Commision)",
        "Supplier Discounted Price",
        "Discounted Price",
      ])
    );

    totalSupplierListedPrice += listedPrice;
    totalSupplierDiscountedPrice += discountedPrice;

    if (status.includes("delivered")) {
      sellInMonthProducts += 1;
      deliveredSupplierDiscountedPriceTotal += discountedPrice;
    }

    if (status.includes("door_step_exchanged")) {
      totalDoorStepExchanger += 80;
    }

    let matched = false;
    if (
      status.includes("rto_complete") ||
      status.includes("rto_locked") ||
      status.includes("rto_initiated")
    ) {
      categories["rto"].push(row);
      matched = true;
    } else {
      statusList.forEach((s) => {
        if (s !== "all" && s !== "rto" && status.includes(s)) {
          categories[s].push(row);
          matched = true;
        }
      });
    }

    if (!matched) categories.other.push(row);
  });

  const totalProfit =
    deliveredSupplierDiscountedPriceTotal - sellInMonthProducts * 500;

  const profitPercent =
    sellInMonthProducts !== 0
      ? (totalProfit / (sellInMonthProducts * 500)) * 100
      : 0;

  categories.totals = {
    totalSupplierListedPrice,
    totalSupplierDiscountedPrice,
    sellInMonthProducts,
    deliveredSupplierDiscountedPriceTotal,
    totalDoorStepExchanger,
    totalProfit,
    profitPercent: profitPercent.toFixed(2),
  };

  return categories;
}
app.post("/upload", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file uploaded" });

  const ext = path.extname(file.originalname).toLowerCase();
  let rows = [];

  try {
    if (ext === ".csv") {
      fs.createReadStream(file.path)
        .pipe(csv())
        .on("data", (data) => rows.push(data))
        .on("end", async () => {
          fs.unlinkSync(file.path);
          saveData(rows, res);
        });
    } else if (ext === ".xlsx" || ext === ".xls") {
      const workbook = XLSX.readFile(file.path);
      const sheetName = workbook.SheetNames[0];
      rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
      fs.unlinkSync(file.path);
      saveData(rows, res);
    } else {
      fs.unlinkSync(file.path);
      return res.status(400).json({ error: "Unsupported file format" });
    }
  } catch (error) {
    console.error(" Error processing file:", error);
    return res.status(500).json({ error: "Failed to process file" });
  }
});
function saveData(rows, res) {
  if (!rows || !rows.length)
    return res.status(400).json({ message: "No data to save" });

  const categorized = categorizeRows(rows);
  const profitByDate = {};
  rows.forEach((row) => {
    const status = (row["Reason for Credit Entry"] || "").toLowerCase().trim();
    if (!status.includes("delivered")) return;

    const dateKey =
      row["Order Date"] ||
      row["Date"] ||
      row["Created At"] ||
      row["Delivered Date"];
    if (!dateKey) return;

    const date = new Date(dateKey).toISOString().split("T")[0];

    const discountedPrice = parsePrice(
      getColumnValue(row, [
        "Supplier Discounted Price (Incl GST and Commission)",
        "Supplier Discounted Price (Incl GST and Commision)",
        "Supplier Discounted Price",
        "Discounted Price",
      ])
    );

    if (!profitByDate[date]) {
      profitByDate[date] = { total: 0, count: 0 };
    }

    profitByDate[date].total += discountedPrice;
    profitByDate[date].count += 1;
  });

  const profitGraphArray = Object.keys(profitByDate).map((date) => {
    const { total, count } = profitByDate[date];
    return {
      date,
      profit: total - count * 500,
    };
  });

  latestData = {
    submittedAt: new Date(),
    data: rows,
    totals: categorized.totals,
    categories: categorized,
    profitByDate: profitGraphArray,
  };

  console.log(" Data stored in memory");
  return res.json({ ...categorized, profitByDate: profitGraphArray });
}

app.get("/profit-graph", (req, res) => {
  if (!latestData) return res.status(404).json({ error: "No data found" });
  res.json(latestData.profitByDate || []);
});

function formatINR(n) {
  const num = Number(n) || 0;
  return "₹" + num.toLocaleString("en-IN");
}
app.get("/download-pdf", (req, res) => {
  if (!latestData) return res.status(404).json({ error: "No data found" });

  const categorized = latestData.categories || {};
  const totals = latestData.totals || {};

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "attachment; filename=dashboard-report.pdf");

  const doc = new PDFDocument({ margin: 40, size: "A4" });
  doc.pipe(res);

  doc.fontSize(18).font("Helvetica-Bold").text(" Dashboard Report", { align: "center" });
  doc.moveDown(1);

  const metrics = [
    ["All Orders", (categorized.all || []).length || 0],
    ["RTO", (categorized.rto || []).length || 0],
    ["Door Step Exchanged", (categorized.door_step_exchanged || []).length || 0],
    ["Delivered (count / discounted total)", `${totals?.sellInMonthProducts || 0} / ₹${totals?.deliveredSupplierDiscountedPriceTotal || 0}`],
    ["Cancelled", (categorized.cancelled || []).length || 0],
    ["Pending", (categorized.ready_to_ship || []).length || 0],
    ["Shipped", (categorized.shipped || []).length || 0],
    ["Other", (categorized.other || []).length || 0],
    ["Supplier Listed Total Price", `₹${totals?.totalSupplierListedPrice || 0}`],
    ["Supplier Discounted Total Price", `₹${totals?.totalSupplierDiscountedPrice || 0}`],
    ["Total Profit", `₹${totals?.totalProfit || 0}`],
    ["Profit %", `${totals?.profitPercent || "0.00"}%`],
  ];

  const startX = doc.x;
  let startY = doc.y;
  const col1Width = 250;
  const col2Width = 150;
  const rowHeight = 20;

  doc.rect(startX, startY, col1Width, rowHeight).stroke();
  doc.rect(startX + col1Width, startY, col2Width, rowHeight).stroke();
  doc.font("Helvetica-Bold").text("Metric", startX + 5, startY + 5, { width: col1Width - 10 });
  doc.text("Value", startX + col1Width + 5, startY + 5, { width: col2Width - 10 });
  startY += rowHeight;

  doc.font("Helvetica");
  metrics.forEach(([metric, value], i) => {
    doc.rect(startX, startY, col1Width, rowHeight).stroke();
    doc.rect(startX + col1Width, startY, col2Width, rowHeight).stroke();
    doc.text(metric, startX + 5, startY + 5, { width: col1Width - 10 });
    doc.text(value.toString(), startX + col1Width + 5, startY + 5, { width: col2Width - 10 });
    startY += rowHeight;
  });

  doc.end();
});

app.listen(PORT, () =>
  console.log(` Server running on http://localhost:${PORT}`)
);
