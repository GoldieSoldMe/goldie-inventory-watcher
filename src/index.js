const INVENTORY_PAGE = "https://fortcollins.clscars.com/vehicles/";
const INVENTORY_FEED = "https://fortcollins.clscars.com/wp-json/cls/v2/vehicles";

const DEFAULT_PHONE = "720-595-0359";
const DEFAULT_NAME = "Matt Goldie";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return json({
        ok: true,
        service: "Goldie Inventory Watcher",
        inventory: INVENTORY_PAGE,
        feed: INVENTORY_FEED,
        schedule: "3:00 AM + 3:00 PM America/Denver",
      });
    }

    if (url.pathname === "/run") {
      try {
        const result = await checkInventory(env, {
          forceEmail: url.searchParams.get("force") === "1",
        });
        return json(result);
      } catch (error) {
        console.error(error);
        return json({ ok: false, error: error.message }, 500);
      }
    }

    if (url.pathname === "/feed-test") {
      try {
        const response = await fetch(INVENTORY_FEED, { headers: browserHeaders() });
        const data = await response.json();
        const vehicles = normalizeClsFeed(data);

        return json({
          ok: true,
          status: response.status,
          detected: vehicles.length,
          sample: vehicles.slice(0, 5),
        });
      } catch (error) {
        return json({ ok: false, error: error.message }, 500);
      }
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledCheck(env));
  },
};

async function runScheduledCheck(env) {
  const now = getDenverParts();
  if (now.minute !== 0) return;
  if (now.hour !== 3 && now.hour !== 15) return;

  const windowKey = `schedule:${now.year}-${now.month}-${now.day}-${now.hour}`;
  const alreadyRan = await env.INVENTORY_KV.get(windowKey);
  if (alreadyRan) return;

  await env.INVENTORY_KV.put(windowKey, "1", { expirationTtl: 172800 });
  await checkInventory(env);
}

async function checkInventory(env, options = {}) {
  if (!env.INVENTORY_KV) throw new Error("INVENTORY_KV binding is missing.");

  const vehicles = await fetchInventory();
  if (!vehicles.length) throw new Error("CLS inventory feed returned no usable vehicles.");

  const initialized = await env.INVENTORY_KV.get("inventory_initialized");

  if (!initialized) {
    for (const vehicle of vehicles) await saveVehicle(env, vehicle);

    await env.INVENTORY_KV.put("inventory_initialized", new Date().toISOString());

    await sendEmail(env, {
      subject: `Goldie Inventory Watcher is live — ${vehicles.length} vehicles saved`,
      html: `<div style="font-family:Arial,sans-serif;line-height:1.5;max-width:700px;margin:auto;">
        <h2>Goldie Inventory Watcher is live ✅</h2>
        <p>I found <strong>${vehicles.length}</strong> vehicles currently in CLS inventory.</p>
        <p>Those vehicles have been saved as the starting baseline.</p>
        <p>Starting now, newly added inventory will generate its own Marketplace-ready email.</p>
        <p><strong>Schedule:</strong> 3:00 AM + 3:00 PM Mountain Time</p>
      </div>`,
    });

    return { ok: true, baselineCreated: true, vehicleCount: vehicles.length };
  }

  const newVehicles = [];

  for (const vehicle of vehicles) {
    const key = vehicleStorageKey(vehicle);
    const existing = await env.INVENTORY_KV.get(key);

    if (!existing || options.forceEmail) newVehicles.push(vehicle);
    await saveVehicle(env, vehicle);
  }

  if (!newVehicles.length) {
    return { ok: true, checked: vehicles.length, newVehicles: 0, message: "No new vehicles found." };
  }

  for (const vehicle of newVehicles) {
    await sendVehicleEmail(env, vehicle, generateMarketplacePost(vehicle));
  }

  return {
    ok: true,
    checked: vehicles.length,
    newVehicles: newVehicles.length,
    vehicles: newVehicles.map((vehicle) => ({
      id: vehicle.id,
      stock: vehicle.stock,
      title: vehicleTitle(vehicle),
      price: vehicle.price,
      mileage: vehicle.mileage,
    })),
  };
}

async function fetchInventory() {
  const response = await fetch(INVENTORY_FEED, { headers: browserHeaders() });

  if (!response.ok) {
    throw new Error(`CLS inventory feed returned ${response.status}: ${response.statusText}`);
  }

  return normalizeClsFeed(await response.json());
}

function normalizeClsFeed(data) {
  const vehicles = [];
  walkForResources(data, vehicles);
  return dedupeVehicles(vehicles);
}

function walkForResources(value, output) {
  if (!value) return;

  if (Array.isArray(value)) {
    for (const item of value) walkForResources(item, output);
    return;
  }

  if (typeof value !== "object") return;

  if (Array.isArray(value.resources)) {
    for (const raw of value.resources) {
      const vehicle = normalizeClsVehicle(raw);
      if (vehicle && (vehicle.id || vehicle.stock || vehicle.url)) output.push(vehicle);
    }
  }

  for (const [key, child] of Object.entries(value)) {
    if (key !== "resources") walkForResources(child, output);
  }
}

function normalizeClsVehicle(raw) {
  if (!raw || typeof raw !== "object") return null;

  const title = cleanText(raw.post_title || raw.title || raw.name || "");
  const parsedTitle = parseVehicleTitle(title);

  return {
    id: cleanText(raw.ID || raw.id),
    vin: cleanText(raw.vin || raw.VIN),
    stock: cleanText(raw.stock || raw.stock_number || raw.stockNumber) || extractStockFromSlug(raw.post_name),
    year: cleanText(raw.year) || parsedTitle.year,
    make: cleanText(raw.make) || parsedTitle.make,
    model: cleanText(raw.model) || parsedTitle.model,
    trim: cleanText(raw.trim),
    price: normalizePrice(raw.price ?? raw.sale_price ?? raw.internet_price),
    mileage: normalizeMileage(raw.miles ?? raw.mileage ?? raw.odometer),
    drivetrain: cleanText(raw.drivetrain || raw.drive_train || raw.drive),
    exteriorColor: cleanText(raw.exterior_color || raw.exteriorColor || raw.color),
    bodyStyle: cleanText(raw.body_style || raw.bodyStyle || raw.body_type),
    url: cleanUrl(raw.link || raw.guid || raw.url),
    images: extractImages(raw),
    rawTitle: title,
  };
}

function extractImages(raw) {
  const found = [];
  for (const candidate of [
    raw.media_url, raw.image, raw.image_url, raw.featured_image,
    raw.thumbnail, raw.photos, raw.images, raw.gallery
  ]) collectImageUrls(candidate, found);

  return [...new Set(found.filter(Boolean))];
}

function collectImageUrls(value, output) {
  if (!value) return;

  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) output.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectImageUrls(item, output);
    return;
  }

  if (typeof value === "object") {
    const direct = value.url || value.src || value.media_url || value.full || value.large;
    if (typeof direct === "string" && /^https?:\/\//i.test(direct)) output.push(direct);
    for (const child of Object.values(value)) collectImageUrls(child, output);
  }
}

function parseVehicleTitle(title) {
  const parts = String(title || "").replace(/\s+/g, " ").trim().split(" ");
  const yearIndex = parts.findIndex((part) => /^(19|20)\d{2}$/.test(part));

  if (yearIndex === -1) {
    return { year: null, make: null, model: title || null };
  }

  return {
    year: parts[yearIndex] || null,
    make: parts[yearIndex + 1] || null,
    model: parts.slice(yearIndex + 2).join(" ") || null,
  };
}

function extractStockFromSlug(slug) {
  if (!slug) return null;
  const match = String(slug).match(/(?:-|_)([A-Za-z0-9]+)$/);
  return match ? match[1] : null;
}

function dedupeVehicles(vehicles) {
  const map = new Map();

  for (const vehicle of vehicles) {
    const key = vehicle.vin || vehicle.stock || vehicle.id || vehicle.url;
    if (!key) continue;

    const normalizedKey = String(key).toUpperCase();
    const current = map.get(normalizedKey) || {};

    map.set(normalizedKey, {
      ...current,
      ...vehicle,
      images: [...new Set([...(current.images || []), ...(vehicle.images || [])])],
    });
  }

  return [...map.values()];
}

async function saveVehicle(env, vehicle) {
  await env.INVENTORY_KV.put(
    vehicleStorageKey(vehicle),
    JSON.stringify({ ...vehicle, lastSeen: new Date().toISOString() })
  );
}

function vehicleStorageKey(vehicle) {
  const identifier = vehicle.vin || vehicle.stock || vehicle.id || vehicle.url;
  return `vehicle:${String(identifier).toUpperCase()}`;
}

function generateMarketplacePost(vehicle) {
  const title = vehicleTitle(vehicle);
  const hook = getVehicleHook(vehicle);

  const lines = [hook, "", `${title} just became available!`, ""];

  if (vehicle.price) lines.push(`💰 ${formatPrice(vehicle.price)}`);
  if (vehicle.mileage !== null && vehicle.mileage !== undefined) {
    lines.push(`🛣 ${formatMileage(vehicle.mileage)} miles`);
  }
  if (vehicle.exteriorColor) lines.push(`🎨 ${vehicle.exteriorColor}`);
  if (vehicle.drivetrain) lines.push(`⚙️ ${vehicle.drivetrain}`);

  lines.push(
    "",
    "📍 Centennial Leasing & Sales — Northern Colorado",
    "",
    `Message me here or call/text ${DEFAULT_NAME} at ${DEFAULT_PHONE}. I respond quickly.`,
    "",
    "Even if this one isn't exactly what you're looking for, reach out anyway — finding the right vehicle is what I do best.",
    "",
    "— Matt Goldie",
    "GoldieSoldMe"
  );

  return lines.join("\n");
}

function getVehicleHook(vehicle) {
  const text = [
    vehicle.make, vehicle.model, vehicle.trim, vehicle.bodyStyle, vehicle.rawTitle
  ].filter(Boolean).join(" ").toLowerCase();

  const seed = hashString(vehicle.vin || vehicle.stock || vehicle.id || vehicleTitle(vehicle));
  let hooks;

  if (/suburban|yukon xl|expedition max|grand wagoneer|wagoneer/.test(text)) {
    hooks = [
      "Looking for a bigger vehicle? 🚗",
      "Need room for everybody — and everything? 🚙",
      "If space is at the top of your list, check this one out 👀",
    ];
  } else if (/tahoe|yukon|expedition|sequoia|armada/.test(text)) {
    hooks = [
      "Looking for a full-size SUV? 🚙",
      "Need the space without giving up capability? 👀",
      "Family hauler, road-trip machine, daily driver — this checks a lot of boxes 👀",
    ];
  } else if (/telluride|palisade|highlander|pilot|traverse|explorer|pathfinder|grand cherokee l|atlas|cx-90/.test(text)) {
    hooks = [
      "Need three rows without going full-size? 🚙",
      "Looking for something the whole family can fit in? 👀",
      "Need more room for the family without driving a bus? 😂",
    ];
  } else if (/tacoma|colorado|canyon|ranger|frontier|ridgeline|maverick/.test(text)) {
    hooks = [
      "Need a truck without going full-size? 🛻",
      "Looking for a midsize truck? This one just showed up 👀",
      "Want truck capability without the giant footprint? 🛻",
    ];
  } else if (/f-150|silverado|sierra|ram 1500|tundra/.test(text)) {
    hooks = [
      "Looking for your next truck? 🛻",
      "Need something that can work during the week and play on the weekend? 👀",
      "Truck people — this one just hit inventory 🛻",
    ];
  } else if (/f-250|f-350|2500|3500|super duty|duramax|cummins/.test(text)) {
    hooks = [
      "Need a serious truck? 🛻",
      "Looking for something built to work? 👀",
      "If towing and capability matter, take a look at this one 🛻",
    ];
  } else if (/corvette|supra|mustang|camaro|challenger|911|cayman|m3|m4|amg/.test(text)) {
    hooks = [
      "Okay… this one probably doesn't need much of an introduction. 😮‍💨",
      "Looking for something a little more fun? 👀",
      "This is definitely not your average commuter 😮‍💨",
    ];
  } else if (/escalade|denali|range rover|lexus|mercedes|bmw|audi|genesis/.test(text)) {
    hooks = [
      "Looking for something a little more luxurious? ✨",
      "Want the comfort without giving up the style? 👀",
      "Need the space but don't want to give up the luxury? 👀",
    ];
  } else if (/prius|camry|corolla|civic|accord|elantra|sonata|sentra|altima/.test(text)) {
    hooks = [
      "Looking for a dependable daily driver? 🚗",
      "Need something easy to live with every day? 👀",
      "Looking for a commuter that makes sense? 🚗",
    ];
  } else if (/wrangler|bronco|4runner/.test(text)) {
    hooks = [
      "Ready for something a little more fun? 👀",
      "Need something that's just as ready for the weekend as you are? 🚙",
      "Adventure vehicle anyone? 👀",
    ];
  } else {
    hooks = [
      "Looking for your next vehicle? 👀",
      "This one just hit our inventory 🚗",
      "Fresh inventory alert 👀",
      "Another one just became available 🚗",
    ];
  }

  return hooks[seed % hooks.length];
}

async function sendVehicleEmail(env, vehicle, post) {
  const title = vehicleTitle(vehicle);

  const imageHtml = (vehicle.images || []).slice(0, 12).map(
    (url) => `<a href="${escapeHtml(url)}" style="display:inline-block;margin:4px;">
      <img src="${escapeHtml(url)}" width="180" style="border-radius:8px;display:block;" />
    </a>`
  ).join("");

  const photoLinks = (vehicle.images || []).slice(0, 12).map(
    (url, index) => `<a href="${escapeHtml(url)}">Photo ${index + 1}</a>`
  ).join(" &nbsp; ");

  const detailRows = [
    ["Stock", vehicle.stock],
    ["VIN", vehicle.vin],
    ["Price", vehicle.price ? formatPrice(vehicle.price) : null],
    ["Mileage", vehicle.mileage !== null && vehicle.mileage !== undefined ? `${formatMileage(vehicle.mileage)} miles` : null],
    ["Drivetrain", vehicle.drivetrain],
    ["Color", vehicle.exteriorColor],
  ].filter(([, value]) => value)
    .map(([label, value]) => `<strong>${label}:</strong> ${escapeHtml(value)}`)
    .join("<br>");

  const vehicleLink = vehicle.url
    ? `<p><a href="${escapeHtml(vehicle.url)}">Open full vehicle listing</a></p>`
    : "";

  await sendEmail(env, {
    subject: `NEW INVENTORY — ${title}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:760px;margin:auto;line-height:1.5">
      <h2>🚨 NEW INVENTORY — NOT POSTED</h2>
      <h3>${escapeHtml(title)}</h3>
      <p>${detailRows}</p>
      ${vehicleLink}
      ${imageHtml ? `<h3>Vehicle Photos</h3><div>${imageHtml}</div><p>${photoLinks}</p>` : `<p><em>No vehicle photo URLs were supplied by the inventory feed.</em></p>`}
      <hr style="margin:30px 0">
      <h3>Facebook Marketplace Copy</h3>
      <div style="white-space:pre-wrap;background:#f4f4f4;border-radius:10px;padding:18px;font-size:16px;">${escapeHtml(post)}</div>
      <p style="margin-top:25px;color:#666;">Copy the post above into Facebook Marketplace.</p>
    </div>`,
  });
}

async function sendEmail(env, { subject, html }) {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is missing from Cloudflare.");
  if (!env.ALERT_EMAIL) throw new Error("ALERT_EMAIL is missing from Cloudflare.");

  const from = env.FROM_EMAIL || "Goldie Inventory <onboarding@resend.dev>";

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [env.ALERT_EMAIL],
      subject,
      html,
    }),
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result?.message || `Resend returned HTTP ${response.status}`);
  }

  return result;
}

function vehicleTitle(vehicle) {
  return [vehicle.year, vehicle.make, vehicle.model, vehicle.trim]
    .filter(Boolean)
    .join(" ")
    .trim() ||
    vehicle.rawTitle ||
    vehicle.stock ||
    vehicle.id ||
    "New Vehicle";
}

function getDenverParts() {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  const pieces = Object.fromEntries(
    formatter.formatToParts(new Date())
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return {
    year: pieces.year,
    month: pieces.month,
    day: pieces.day,
    hour: Number(pieces.hour),
    minute: Number(pieces.minute),
  };
}

function normalizePrice(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(String(value).replace(/[^\d.]/g, ""));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeMileage(value) {
  if (value === undefined || value === null || value === "") return null;

  if (typeof value === "object") {
    value = value.value || value.mileage || value.miles;
  }

  const number = Number(String(value).replace(/[^\d.]/g, ""));
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function formatPrice(value) {
  return `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function formatMileage(value) {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function cleanText(value) {
  if (value === undefined || value === null) return null;
  const result = String(value).replace(/\s+/g, " ").trim();
  return result || null;
}

function cleanUrl(value) {
  const text = cleanText(value);
  if (!text) return null;

  try {
    return new URL(text).toString();
  } catch {
    return null;
  }
}

function hashString(value) {
  const input = String(value || "");
  let hash = 0;

  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }

  return Math.abs(hash);
}

function browserHeaders() {
  return {
    "User-Agent": "Mozilla/5.0 (compatible; GoldieInventoryWatcher/2.0)",
    Accept: "application/json,text/plain,*/*",
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
