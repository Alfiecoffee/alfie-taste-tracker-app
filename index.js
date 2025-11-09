// index.js
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables set in Render
const SHOP = process.env.SHOPIFY_SHOP_DOMAIN;     // e.g. "www-alfiecoffee-co-uk.myshopify.com"
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

app.use(express.json());

// Allow requests from your live site + Shopify domain
app.use((req, res, next) => {
  const allowedOrigins = [
    "https://alfiecoffee.co.uk",
    "https://alfiecoffee.myshopify.com"
  ];
  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Credentials", "false");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});


// ------------------------------
// Helper to talk to Shopify Admin GraphQL API
// ------------------------------
async function shopifyGraphQL(query, variables = {}) {
  const url = `https://${SHOP}/admin/api/2025-01/graphql.json`;
  console.log("Shopify GraphQL URL:", url);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": ADMIN_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await res.json();

  // HTTP-level error (bad domain, token, or version)
  if (!res.ok) {
    console.error("HTTP error from Shopify:", res.status, json);
    throw new Error(`HTTP ${res.status} from Shopify`);
  }

  // GraphQL-level errors
  if (json.errors && json.errors.length) {
    console.error("GraphQL errors:", JSON.stringify(json.errors, null, 2));
    const msg = json.errors[0]?.message || "Shopify GraphQL error";
    throw new Error(msg);
  }

  return json.data;
}


// ------------------------------
// Get existing passport metafield
// ------------------------------
async function getPassport(customerId) {
  const gid = `gid://shopify/Customer/${customerId}`;

  const query = `
    query GetPassport($id: ID!) {
      customer(id: $id) {
        metafield(namespace: "tastetracker", key: "passport") {
          value
        }
      }
    }
  `;

  const data = await shopifyGraphQL(query, { id: gid });
  const metafield = data.customer && data.customer.metafield;

  if (!metafield || !metafield.value) {
    return {};
  }

  try {
    return JSON.parse(metafield.value);
  } catch (e) {
    console.error("Failed to parse passport JSON", e);
    return {};
  }
}


// ------------------------------
// Save updated passport metafield
// ------------------------------
async function savePassport(customerId, passport) {
  const gid = `gid://shopify/Customer/${customerId}`;

  const mutation = `
    mutation SavePassport($id: ID!, $value: String!) {
      customerUpdate(input: {
        id: $id,
        metafields: [{
          namespace: "tastetracker",
          key: "passport",
          type: "json",
          value: $value
        }]
      }) {
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    id: gid,
    value: JSON.stringify(passport)
  };

  const data = await shopifyGraphQL(mutation, variables);
  const errors = data.customerUpdate.userErrors;

  if (errors && errors.length > 0) {
    console.error("Metafield save errors:", errors);
    throw new Error(errors[0].message);
  }
}


// ------------------------------
// Helpers for roast data shape
// ------------------------------
function normaliseRoast(rawRoast) {
  if (!rawRoast) {
    return { entries: [] };
  }

  // Already in new format
  if (Array.isArray(rawRoast.entries)) {
    return { entries: rawRoast.entries.slice() };
  }

  // Legacy single-entry format => wrap into entries[0]
  const now = new Date().toISOString();
  const entry = {
    id: rawRoast.id || now,
    created_at: rawRoast.created_at || now,
    updated_at: rawRoast.updated_at || rawRoast.created_at || now,
    brew_method: rawRoast.brew_method || "",
    grinding_from_whole_bean: Boolean(rawRoast.grinding_from_whole_bean),
    grind_notes: rawRoast.grind_notes || "",
    brew_recipe: rawRoast.brew_recipe || "",
    rating: Number(rawRoast.rating || 0),
    notes: rawRoast.notes || "",
    outcome: rawRoast.outcome || ""
  };

  return { entries: [entry] };
}


// ------------------------------
// Main endpoint (called from your Passport page)
// ------------------------------
app.post("/save", async (req, res) => {
  try {
    const {
      customer_id,
      roast_handle,
      entry_id,
      action,
      rating,
      brew_method,
      grinding_from_whole_bean,
      grind_notes,
      brew_recipe,
      notes,
      outcome
    } = req.body;

    if (!customer_id || !roast_handle) {
      return res.status(400).json({
        ok: false,
        error: "Missing customer_id or roast_handle"
      });
    }

    const passport = await getPassport(customer_id);
    const roast = normaliseRoast(passport[roast_handle]);

    const now = new Date().toISOString();

    // Find existing entry if entry_id given
    let existingIndex = -1;
    let existingEntry = null;
    if (entry_id) {
      existingIndex = roast.entries.findIndex(e => e.id === entry_id);
      if (existingIndex !== -1) {
        existingEntry = roast.entries[existingIndex];
      }
    }

    // --- RESET CURRENT TASTING (clear fields, keep entry + timestamps) ---
    if (action === "reset") {
      if (!existingEntry) {
        // Nothing to reset (unsaved or id not found)
        return res.json({ ok: true, reset: true });
      }

      const cleared = {
        ...existingEntry,
        brew_method: "",
        grinding_from_whole_bean: false,
        grind_notes: "",
        brew_recipe: "",
        rating: 0,
        notes: "",
        outcome: "",
        updated_at: now
      };

      roast.entries[existingIndex] = cleared;
      passport[roast_handle] = roast;

      await savePassport(customer_id, passport);

      return res.json({
        ok: true,
        reset: true,
        entry: cleared
      });
    }

    // --- SAVE / UPDATE TASTING ---
    let finalEntryId = entry_id;

    if (existingEntry) {
      // Update existing entry
      const updated = {
        ...existingEntry,
        brew_method: brew_method || "",
        grinding_from_whole_bean: Boolean(grinding_from_whole_bean),
        grind_notes: grind_notes || "",
        brew_recipe: brew_recipe || "",
        rating: Number(rating || 0),
        notes: notes || "",
        outcome: outcome || "",
        updated_at: now
      };

      roast.entries[existingIndex] = updated;
      finalEntryId = updated.id;
    } else {
      // Create new entry
      const newId = entry_id || now; // front end can send id; if not, use timestamp
      const entry = {
        id: newId,
        created_at: now,
        updated_at: now,
        brew_method: brew_method || "",
        grinding_from_whole_bean: Boolean(grinding_from_whole_bean),
        grind_notes: grind_notes || "",
        brew_recipe: brew_recipe || "",
        rating: Number(rating || 0),
        notes: notes || "",
        outcome: outcome || ""
      };

      roast.entries.push(entry);
      finalEntryId = entry.id;
    }

    passport[roast_handle] = roast;
    await savePassport(customer_id, passport);

    res.json({
      ok: true,
      entry_id: finalEntryId
    });
  } catch (e) {
    console.error("Error in /save:", e);
    res.status(500).json({
      ok: false,
      error: e.message || "Server error"
    });
  }
});


// ------------------------------
// Health check route
// ------------------------------
app.get("/", (req, res) => {
  res.send("Alfie Taste Tracker app is running.");
});

app.listen(PORT, () => {
  console.log(`Taste Tracker app listening on port ${PORT}`);
});
