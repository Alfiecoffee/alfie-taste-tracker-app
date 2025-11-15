// index.js
const express = require("express");
const { MongoClient, ServerApiVersion } = require("mongodb"); 

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables set in Render
const SHOP = process.env.SHOPIFY_SHOP_DOMAIN;      
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const MONGO_URI = process.env.MONGO_URI; 

// --- MONGODB CONNECTION SETUP (CRITICAL FIX: Server waits for connection) ---
let db;
const client = new MongoClient(MONGO_URI, {
    // Flags required for stable connection on modern Node.js/Atlas
    useNewUrlParser: true,
    useUnifiedTopology: true, 
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function connectDB() {
    try {
        await client.connect();
        // Database name should be explicitly defined (e.g., 'CoffeeJournalDB')
        db = client.db("CoffeeJournalDB"); 
        console.log("Successfully connected to MongoDB.");
        
        // --- START SERVER ONLY IF DB IS CONNECTED ---
        app.listen(PORT, () => {
            console.log(`Taste Tracker app listening on port ${PORT}`);
        });
        // -------------------------------------------

    } catch (e) {
        // Log the error and exit the process, forcing Render to report a failure
        console.error("Failed to connect to MongoDB. Server will not start:", e);
        // The error will be visible in the Render logs.
        process.exit(1); 
    }
}
connectDB();
// --- END MONGODB CONNECTION ---

app.use(express.json());

// Allow requests from your live site + Shopify domain
app.use((req, res, next) => {
    const allowedOrigins = [
        "https://alfiecoffee.co.uk",
        `https://${SHOP}`,
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
// Helper to talk to Shopify Admin GraphQL API (KEPT FOR LEGACY READS)
// ------------------------------
async function shopifyGraphQL(query, variables = {}) {
    const url = `https://${SHOP}/admin/api/2025-01/graphql.json`;

    const res = await fetch(url, {
        method: "POST",
        headers: {
            "X-Shopify-Access-Token": ADMIN_TOKEN,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ query, variables })
    });

    const json = await res.json();

    if (!res.ok) {
        console.error("HTTP error from Shopify:", res.status, json);
        throw new Error(`HTTP ${res.status} from Shopify`);
    }

    if (json.errors && json.errors.length) {
        console.error("GraphQL errors:", JSON.stringify(json.errors, null, 2));
        const msg = json.errors[0]?.message || "Shopify GraphQL error";
        throw new Error(msg);
    }

    return json.data;
}


// ------------------------------
// Legacy Shopify Read Helper (KEPT FOR DATA MIGRATION)
// ------------------------------
async function getLegacyShopifyPassport(customerId) {
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

    try {
        const data = await shopifyGraphQL(query, { id: gid });
        const metafield = data.customer && data.customer.metafield;

        if (!metafield || !metafield.value) {
            return {};
        }
        return JSON.parse(metafield.value);
    } catch (e) {
        console.error("Failed to fetch/parse legacy passport JSON", e);
        return {};
    }
}


// ------------------------------
// NEW: MongoDB Helpers for Data Persistence
// ------------------------------

// Get the collection for journal entries (one document per customer)
function getJournalCollection() {
    return db.collection("journal_entries");
}

/**
 * Reads data from MongoDB. If not found, attempts to read/migrate legacy Shopify data.
 */
async function getPassport(customerId, migrate = true) {
    if (!db) {
        console.warn("MongoDB not connected. Falling back to live metafield read.");
        return await getLegacyShopifyPassport(customerId);
    }

    const journalCollection = getJournalCollection();
    
    // 1. Try to read from the new MongoDB database first
    const mongoDoc = await journalCollection.findOne({ customerId: customerId });
    
    if (mongoDoc) {
        return mongoDoc.passport || {};
    }

    // 2. If MongoDB data is empty, fetch LEGACY data from Shopify
    const shopifyData = await getLegacyShopifyPassport(customerId);

    // 3. Migrate legacy data to MongoDB (on first read)
    if (migrate && Object.keys(shopifyData).length > 0) {
        await journalCollection.insertOne({
            customerId: customerId,
            passport: shopifyData,
            migratedAt: new Date().toISOString()
        });
        console.log(`Migrated legacy data for customer ${customerId}`);
    }

    return shopifyData;
}


/**
 * Saves the entire updated passport object to MongoDB. (Replaces slow metafield write)
 */
async function savePassport(customerId, updatedPassport) {
    if (!db) {
        console.error("MongoDB not connected. Save failed.");
        throw new Error("Database connection required for saving."); 
    }

    const journalCollection = getJournalCollection();
    
    // Update the entire passport document in MongoDB
    await journalCollection.updateOne(
        { customerId: customerId },
        { 
            $set: { 
                passport: updatedPassport,
                lastUpdatedAt: new Date().toISOString()
            } 
        },
        { upsert: true } // Create the document if it doesn't exist
    );
}

// ------------------------------
// Helpers for roast data shape (KEPT)
// ------------------------------
function normaliseRoast(rawRoast) {
    if (!rawRoast) {
        return { entries: [] };
    }

    if (Array.isArray(rawRoast.entries)) {
        return { entries: rawRoast.entries.slice() };
    }

    const now = new Date().toISOString();
    const entry = {
        id: rawRoast.id || now,
        created_at: rawRoast.created_at || now,
        updated_at: rawRoast.updated_at || rawRoast.created_at || now,
        brew_method: rawRoast.brew_method || "",
        grinding_from_whole_bean: Boolean(rawRoast.grinding_from_whole_bean),
        grind_notes: rawRoast.grind_notes || "",
        grinder_setting: rawRoast.grinder_setting || "",
        brew_recipe: rawRoast.brew_recipe || "",
        rating: Number(rawRoast.rating || 0),
        notes: rawRoast.notes || "",
        outcome: rawRoast.outcome || ""
    };

    return { entries: [entry] };
}


// ------------------------------
// App Proxy Read Endpoint (App Proxy GET /apps/alfie-tracker/passport-data)
// ------------------------------
app.get("/apps/alfie-tracker/passport-data", async (req, res) => {
    try {
        const customerId = req.query.customer_id;

        if (!customerId) {
            return res.status(400).json({ ok: false, error: "Missing customer_id parameter" });
        }

        // Uses new MongoDB read path (with built-in migration from Shopify)
        const passportData = await getPassport(customerId); 

        res.json(passportData); 
    } catch (e) {
        console.error("Error in /passport-data:", e);
        res.status(500).json({
            ok: false,
            error: e.message || "Server error during data retrieval"
        });
    }
});


// ------------------------------
// Save Endpoint (POST /save)
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
            grinder_setting,
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

        const now = new Date().toISOString();
        
        // --- READ existing data from the database ---
        const passport = await getPassport(customer_id, false); 
        const roast = normaliseRoast(passport[roast_handle]);

        // Find existing entry if entry_id given
        let existingEntry = null;
        let existingIndex = -1;
        if (entry_id) {
            existingIndex = roast.entries.findIndex(e => e.id === entry_id);
            if (existingIndex !== -1) {
                existingEntry = roast.entries[existingIndex];
            }
        }

        // --- RESET CURRENT TASTING (MongoDB logic) ---
        if (action === "reset") {
            if (!existingEntry) {
                return res.json({ ok: true, reset: true });
            }

            // Remove the entry completely 
            roast.entries = roast.entries.filter(e => e.id !== entry_id);
            passport[roast_handle] = roast;

            // SAVE to MongoDB
            await savePassport(customer_id, passport);

            return res.json({
                ok: true,
                reset: true
            });
        }

        // --- SAVE / UPDATE TASTING ---
        let finalEntryId = entry_id;

        const updatedEntryData = {
            brew_method: brew_method || "",
            grinding_from_whole_bean: Boolean(grinding_from_whole_bean),
            grind_notes: grind_notes || "",
            grinder_setting: grinder_setting || "",
            brew_recipe: brew_recipe || "",
            rating: Number(rating || 0),
            notes: notes || "",
            outcome: outcome || "",
            updated_at: now
        };

        if (existingEntry) {
            // Update existing entry
            const updated = {
                ...existingEntry,
                ...updatedEntryData
            };
            roast.entries[existingIndex] = updated;
            finalEntryId = updated.id;
        } else {
            // Create new entry
            const newId = entry_id || now;
            const newEntry = {
                id: newId,
                created_at: now,
                ...updatedEntryData
            };
            roast.entries.push(newEntry);
            finalEntryId = newEntry.id;
        }

        passport[roast_handle] = roast;
        
        // SAVE to MongoDB
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
    // Only return success if DB is connected for robust health check
    if (db) {
        res.send("Alfie Taste Tracker app is running and connected to MongoDB.");
    } else {
        res.status(503).send("Alfie Taste Tracker app is running but MongoDB connection is down.");
    }
});
