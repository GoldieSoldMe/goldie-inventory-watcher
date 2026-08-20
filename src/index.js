const INVENTORY_PAGE = "https://fortcollins.clscars.com/vehicles/";

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
        schedule: "3:00 AM + 3:00 PM America/Denver",
      });
    }

    if (url.pathname === "/run") {
      if (!env.ADMIN_KEY || url.searchParams.get("key") !== env.ADMIN_KEY) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const result = await checkInventory(env, {
          manual: true,
          forceEmail: url.searchParams.get("force") === "1",
        });

        return json(result);
      } catch (error) {
        console.error(error);
        return json({ ok: false, error: error.message }, 500);
      }
    }

    if (url.pathname === "/debug-source") {
      

      const response = await fetch(INVENTORY_PAGE, {
        headers: browserHeaders(),
      });

      const html = await response.text();

      const scripts = [
        ...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi),
      ].map((m) => absolutize(m[1], INVENTORY_PAGE));

      const suspiciousUrls = [
        ...html.matchAll(
          /https?:\/\/[^\s"'<>]+(?:api|inventory|vehicle|feed)[^\s"'<>]*/gi
        ),
      ].map((m) => m[0]);

      return json({
        status: response.status,
        htmlLength: html.length,
        scripts: [...new Set(scripts)].slice(0, 100),
        suspiciousUrls: [...new Set(suspiciousUrls)].slice(0, 100),
      });
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

  await env.INVENTORY_KV.put(windowKey, "1", {
    expirationTtl: 172800,
  });

  await checkInventory(env);
}

async function checkInventory(env, options = {}) {
  const vehicles = await fetchInventory(env);

  if (!vehicles.length) {
    throw new Error(
      "No vehicles were detected. The CLS site loads inventory dynamically, so INVENTORY_FEED_URL may need to be configured."
    );
  }

  const initialized = await env.INVENTORY_KV.get("inventory_initialized");

  if (!initialized) {
    for (const vehicle of vehicles) {
      await saveVehicle(env, vehicle);
    }

    await env.INVENTORY_KV.put(
      "inventory_initialized",
      new Date().toISOString()
    );

    await sendEmail(env, {
      subject: `Goldie Inventory Watcher is live — ${vehicles.length} vehicles saved`,
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.5">
          <h2>Goldie Inventory Watcher is live ✅</h2>
          <p>I found <strong>${vehicles.length}</strong> vehicles currently in CLS inventory.</p>
          <p>Those vehicles have been saved as the starting baseline. You will not receive alerts for existing units.</p>
          <p>Starting now, newly added inventory will generate a fresh Marketplace-ready post.</p>
          <p>Schedule: <strong>3:00 AM + 3:00 PM Mountain Time</strong></p>
        </div>
      `,
    });

    return {
      ok: true,
      baselineCreated: true,
      vehicleCount: vehicles.length,
    };
  }

  const newVehicles = [];

  for (const vehicle of vehicles) {
    const key = vehicleStorageKey(vehicle);
    const existing = await env.INVENTORY_KV.get(key);

    if (!existing || options.forceEmail) {
      newVehicles.push(vehicle);
    }

    await saveVehicle(env, vehicle);
  }

  if (!newVehicles.length) {
    return {
      ok: true,
      checked: vehicles.length,
      newVehicles: 0,
    };
  }

  for (const vehicle of newVehicles) {
    const post = generateMarketplacePost(vehicle);
    await sendVehicleEmail(env, vehicle, post);
  }

  return {
    ok: true,
    checked: vehicles.length,
    newVehicles: newVehicles.length,
    vehicles: newVehicles.map((v) => ({
      vin: v.vin,
      title: vehicleTitle(v),
      price: v.price,
    })),
  };
}

async function fetchInventory(env) {
  if (env.INVENTORY_FEED_URL) {
    return fetchInventoryFeed(env.INVENTORY_FEED_URL);
  }

  return fetchInventoryFromPage();
}

async function fetchInventoryFeed(feedUrl) {
  const response = await fetch(feedUrl, {
    headers: browserHeaders(),
  });

  if (!response.ok) {
    throw new Error(
      `Inventory feed returned ${response.status}: ${response.statusText}`
    );
  }

  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("json")) {
    return normalizeJsonFeed(await response.json());
  }

  const text = await response.text();

  try {
    return normalizeJsonFeed(JSON.parse(text));
  } catch {
    return parseVehiclesFromHtml(text, feedUrl);
  }
}

async function fetchInventoryFromPage() {
  const response = await fetch(INVENTORY_PAGE, {
    headers: browserHeaders(),
  });

  if (!response.ok) {
    throw new Error(
      `CLS inventory page returned ${response.status}: ${response.statusText}`
    );
  }

  const html = await response.text();
  return parseVehiclesFromHtml(html, INVENTORY_PAGE);
}

function parseVehiclesFromHtml(html, baseUrl) {
  const vehicles = [];

  const jsonLdBlocks = [
    ...html.matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    ),
  ];

  for (const block of jsonLdBlocks) {
    try {
      const parsed = JSON.parse(block[1].trim());
      extractVehicleObjects(parsed, vehicles);
    } catch {}
  }

  const vehicleLinkMatches = [
    ...html.matchAll(
      /href=["']([^"']*(?:vehicle|vehicles|inventory)[^"']*)["']/gi
    ),
  ];

  for (const match of vehicleLinkMatches) {
    const url = absolutize(match[1], baseUrl);

    if (!url || url === INVENTORY_PAGE) continue;

    const vinMatch = url.match(/\b[A-HJ-NPR-Z0-9]{17}\b/i);

    if (!vinMatch) continue;

    vehicles.push({
      vin: vinMatch[0].toUpperCase(),
      url,
    });
  }

  return dedupeVehicles(vehicles);
}

function extractVehicleObjects(value, output) {
  if (!value) return;

  if (Array.isArray(value)) {
    value.forEach((item) => extractVehicleObjects(item, output));
    return;
  }

  if (typeof value !== "object") return;

  const type = Array.isArray(value["@type"])
    ? value["@type"].join(" ")
    : value["@type"];

  if (
    /vehicle|car|product/i.test(type || "") ||
    value.vehicleIdentificationNumber ||
    value.vin
  ) {
    const vehicle = normalizeVehicleObject(value);

    if (vehicle.vin || vehicle.url) {
      output.push(vehicle);
    }
  }

  Object.values(value).forEach((child) =>
    extractVehicleObjects(child, output)
  );
}

function normalizeJsonFeed(data) {
  const candidates = [];
  collectObjects(data, candidates);

  return dedupeVehicles(
    candidates
      .map(normalizeVehicleObject)
      .filter((vehicle) => vehicle.vin || vehicle.url)
  );
}

function collectObjects(value, output) {
  if (!value) return;

  if (Array.isArray(value)) {
    value.forEach((item) => collectObjects(item, output));
    return;
  }

  if (typeof value !== "object") return;

  const looksVehicleLike =
    value.vin ||
    value.VIN ||
    value.vehicleIdentificationNumber ||
    value.stock ||
    value.stockNumber ||
    value.make ||
    value.model ||
    value.year ||
    value.vehicle;

  if (looksVehicleLike) {
    output.push(value);
  }

  Object.values(value).forEach((child) =>
    collectObjects(child, output)
  );
}

function normalizeVehicleObject(raw) {
  const offers = raw.offers || {};
  const brand =
    typeof raw.brand === "object" ? raw.brand?.name : raw.brand;

  let images =
    raw.images ||
    raw.image ||
    raw.photos ||
    raw.photoUrls ||
    raw.imageUrls ||
    [];

  if (!Array.isArray(images)) images = [images];

  images = images
    .map((img) => {
      if (typeof img === "string") return img;
      return img?.url || img?.contentUrl || null;
    })
    .filter(Boolean);

  const title =
    pick(raw.title, raw.name, raw.vehicleName, raw.descriptionTitle) || "";

  let year = pick(raw.year, raw.modelYear, raw.vehicleModelDate);
  let make = pick(raw.make, raw.manufacturer, brand);
  let model = pick(raw.model, raw.vehicleModel);
  let trim = pick(raw.trim, raw.trimLevel, raw.series);

  if ((!year || !make || !model) && title) {
    const parsed = parseTitle(title);
    year ||= parsed.year;
    make ||= parsed.make;
    model ||= parsed.model;
  }

  return cleanVehicle({
    vin: pick(raw.vin, raw.VIN, raw.vehicleIdentificationNumber),
    stock: pick(raw.stock, raw.stockNumber, raw.stock_number),
    year,
    make,
    model,
    trim,
    price: normalizePrice(
      pick(raw.price, raw.salePrice, raw.internetPrice, raw.listPrice, offers.price)
    ),
    mileage: normalizeMileage(
      pick(raw.mileage, raw.odometer, raw.miles)
    ),
    drivetrain: pick(raw.drivetrain, raw.driveTrain, raw.drive),
    exteriorColor: pick(raw.exteriorColor, raw.color, raw.exterior_color),
    bodyStyle: pick(raw.bodyStyle, raw.bodyType, raw.type),
    url: pick(raw.url, raw.vehicleUrl, raw.detailUrl),
    images,
  });
}

function cleanVehicle(vehicle) {
  if (vehicle.vin) {
    vehicle.vin = String(vehicle.vin).trim().toUpperCase();
  }

  for (const key of [
    "year",
    "make",
    "model",
    "trim",
    "stock",
    "drivetrain",
    "exteriorColor",
    "bodyStyle",
  ]) {
    if (vehicle[key] !== undefined && vehicle[key] !== null) {
      vehicle[key] = String(vehicle[key]).trim();
    }
  }

  return vehicle;
}

function dedupeVehicles(vehicles) {
  const map = new Map();

  for (const vehicle of vehicles) {
    const key = vehicle.vin || vehicle.stock || vehicle.url;
    if (!key) continue;

    const current = map.get(key) || {};

    map.set(key, {
      ...current,
      ...vehicle,
      images: [
        ...new Set([
          ...(current.images || []),
          ...(vehicle.images || []),
        ]),
      ],
    });
  }

  return [...map.values()];
}

async function saveVehicle(env, vehicle) {
  const key = vehicleStorageKey(vehicle);

  await env.INVENTORY_KV.put(
    key,
    JSON.stringify({
      ...vehicle,
      lastSeen: new Date().toISOString(),
    })
  );
}

function vehicleStorageKey(vehicle) {
  const identifier = vehicle.vin || vehicle.stock || vehicle.url;
  return `vehicle:${String(identifier).toUpperCase()}`;
}

function generateMarketplacePost(vehicle) {
  const title = vehicleTitle(vehicle);
  const hook = getVehicleHook(vehicle);

  const lines = [
    hook,
    "",
    `${title} just became available!`,
    "",
  ];

  if (vehicle.price) lines.push(`💰 ${formatPrice(vehicle.price)}`);
  if (vehicle.mileage) {
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
    vehicle.make,
    vehicle.model,
    vehicle.trim,
    vehicle.bodyStyle,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const seed = hashString(
    vehicle.vin || vehicle.stock || vehicleTitle(vehicle)
  );

  let hooks;

  if (/suburban|yukon xl|expedition max|wagoneer|grand wagoneer/.test(text)) {
    hooks = [
      "Looking for a bigger vehicle? 👀",
      "Need room for everybody — and everything? 🚙",
      "If space is at the top of your list, check this one out 👀",
    ];
  } else if (/tahoe|yukon|expedition|sequoia|armada/.test(text)) {
    hooks = [
      "Need the space without giving up capability? 👀",
      "Looking for a full-size SUV? 🚙",
      "Family hauler, road-trip machine, daily driver — this checks a lot of boxes 👀",
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
  } else if (/corvette|supra|mustang|camaro|challenger|911|cayman|m3|m4|amg/.test(text)) {
    hooks = [
      "Okay… this one probably doesn't need much of an introduction. 😮‍💨",
      "Looking for something a little more fun? 👀",
      "This is definitely not your average commuter 😮‍💨",
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

  const imageHtml = (vehicle.images || [])
    .slice(0, 12)
    .map(
      (url) => `
        <a href="${escapeHtml(url)}" style="display:inline-block;margin:4px;">
          <img src="${escapeHtml(url)}" width="180" style="border-radius:8px;display:block;" />
        </a>
      `
    )
    .join("");

  const photoLinks = (vehicle.images || [])
    .slice(0, 12)
    .map(
      (url, i) =>
        `<a href="${escapeHtml(url)}">Photo ${i + 1}</a>`
    )
    .join(" &nbsp; ");

  const detailLines = [
    ["VIN", vehicle.vin],
    ["Stock", vehicle.stock],
    ["Price", vehicle.price ? formatPrice(vehicle.price) : null],
    ["Mileage", vehicle.mileage ? `${formatMileage(vehicle.mileage)} miles` : null],
    ["Drivetrain", vehicle.drivetrain],
    ["Color", vehicle.exteriorColor],
  ]
    .filter(([, value]) => value)
    .map(
      ([label, value]) =>
        `<strong>${label}:</strong> ${escapeHtml(value)}`
    )
    .join("<br>");

  const vehicleLink = vehicle.url
    ? `<p><a href="${escapeHtml(vehicle.url)}">Open full vehicle listing</a></p>`
    : "";

  await sendEmail(env, {
    subject: `NEW INVENTORY — ${title}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:750px;margin:auto;line-height:1.5">
        <h2>🚨 NEW INVENTORY — NOT POSTED</h2>
        <h3>${escapeHtml(title)}</h3>
        <p>${detailLines}</p>

        ${vehicleLink}

        ${
          imageHtml
            ? `
          <h3>Vehicle Photos</h3>
          <div>${imageHtml}</div>
          <p>${photoLinks}</p>
        `
            : ""
        }

        <hr style="margin:30px 0">

        <h3>Facebook Marketplace Copy</h3>

        <div style="
          white-space:pre-wrap;
          background:#f4f4f4;
          border-radius:10px;
          padding:18px;
          font-size:16px;
        ">${escapeHtml(post)}</div>

        <p style="margin-top:25px;color:#666">
          Copy the post above into Facebook Marketplace.
        </p>
      </div>
    `,
  });
}

async function sendEmail(env, { subject, html }) {
  if (!env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is missing.");
  }

  if (!env.ALERT_EMAIL) {
    throw new Error("ALERT_EMAIL is missing.");
  }

  const from =
    env.FROM_EMAIL ||
    "Goldie Inventory <onboarding@resend.dev>";

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
    throw new Error(
      result?.message ||
      `Resend returned HTTP ${response.status}`
    );
  }

  return result;
}

function vehicleTitle(vehicle) {
  return [
    vehicle.year,
    vehicle.make,
    vehicle.model,
    vehicle.trim,
  ]
    .filter(Boolean)
    .join(" ") || vehicle.vin || "New Vehicle";
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
    formatter
      .formatToParts(new Date())
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

function parseTitle(title) {
  const words = title.trim().split(/\s+/);
  const yearIndex = words.findIndex((word) =>
    /^(19|20)\d{2}$/.test(word)
  );

  if (yearIndex === -1) return {};

  return {
    year: words[yearIndex],
    make: words[yearIndex + 1],
    model: words[yearIndex + 2],
  };
}

function normalizePrice(value) {
  if (value === undefined || value === null) return null;

  const number = Number(String(value).replace(/[^\d.]/g, ""));

  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeMileage(value) {
  if (value === undefined || value === null) return null;

  if (typeof value === "object") {
    value = value.value || value.valueReference || value.mileage;
  }

  const number = Number(String(value).replace(/[^\d.]/g, ""));

  return Number.isFinite(number) && number >= 0 ? number : null;
}

function formatPrice(value) {
  return `$${Number(value).toLocaleString("en-US", {
    maximumFractionDigits: 0,
  })}`;
}

function formatMileage(value) {
  return Number(value).toLocaleString("en-US", {
    maximumFractionDigits: 0,
  });
}

function pick(...values) {
  return values.find(
    (value) =>
      value !== undefined &&
      value !== null &&
      value !== ""
  );
}

function absolutize(url, base) {
  try {
    return new URL(url, base).toString();
  } catch {
    return null;
  }
}

function hashString(value) {
  let hash = 0;

  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }

  return Math.abs(hash);
}

function browserHeaders() {
  return {
    "User-Agent":
      "Mozilla/5.0 (compatible; GoldieInventoryWatcher/1.0)",
    Accept:
      "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
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
    headers: {
      "Content-Type": "application/json",
    },
  });
}
