#!/usr/bin/env node
import { execSync, spawnSync } from 'child_process';
import { readFile } from 'fs/promises';
import { randomBytes, createHash } from 'crypto';
import { parseArgs } from 'util';

const branchIds = {
  montreal: 1,
  quebec: 2,
  toronto: 3,
};

const branchTenants = {
  1: 'Communauto_Quebec',
  2: 'Communauto_Ontario',
  3: 'Communauto_Atlantic',
};

const branchDomains = {
  1: 'quebec',
  2: 'ontario',
  3: 'atlantic',
};

const userAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const defaultHtmlAccept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

const defaultAcceptLanguage = 'en-CA,en;q=0.9,fr-CA;q=0.8,fr;q=0.7';

const { values } = parseArgs({
  options: {
    delay: {
      type: 'string',
      short: 'd',
      default: '15',
    },
    city: {
      type: 'string',
      short: 'c',
      default: 'toronto',
    },
    location: {
      type: 'string',
      short: 'l',
    },
    radius: {
      type: 'string',
      short: 'r',
    },
    username: {
      type: 'string',
      short: 'U',
    },
    password: {
      type: 'string',
      short: 'P',
    },
    'auth-file': {
      type: 'string',
      short: 'F',
    },
    help: {
      type: "boolean",
      short: "h",
    },
  },
});

if (values.help) {
  console.log(`
Usage: node run.mjs [options]

Options:
  -d, --delay <seconds>   Delay between requests (default: 15)
  -c, --city <name>       City name (default: toronto). Supported cities: ${
    Object.keys(branchIds).join(", ")
  }
  -l, --location <coord>  Location coordinates (e.g. "43.7,-79.4")
  -r, --radius <distance> Search radius in meters or kilometers (e.g. "500", "2km")
  -U, --username <user>   Communauto login username (required to block a car)
  -P, --password <pass>   Communauto login password (required to block a car)
  -F, --auth-file <path>  Path to credentials file with Communauto username/password
  -h, --help              Show this help message

Examples:
  node run.mjs --delay 30 --city montreal
  node run.mjs -d 10 -c vancouver
  node run.mjs -l "45.5,-73.6"
  node run.mjs -r 2km
  node run.mjs --city montreal --username you@example.com --password secret
  node run.mjs --auth-file creds.json
  node run.mjs --help
`);
  process.exit();
}

// In km
const earthRadius = 6371;

// In seconds
const pause = parseInt(values.delay);

const distanceRadii = [
  10000,
  8000,
  6000,
  5000,
  4000,
  3000,
  2000,
  1500,
  1000,
  900,
  800,
  700,
  600,
  500,
  400,
  300,
  200,
];

const defaultRadius = distanceRadii[0];

if (!branchIds[values.city]) {
  throw new Error(`City ${values.city} not yet supported! File a bug`);
}
const branchId = branchIds[values.city];

console.log('Using City Branch: %s. Branch ID: %i', values.city, branchId);

async function main() {
  const customRadius = values.radius ? parseRadius(values.radius) : undefined;
  let distanceRadius = customRadius ?? defaultRadius;
  let notificationId;
  let notifyResult;

  const credentials = await resolveCredentials(values);

  const authSession = await login(credentials.username, credentials.password, branchId);

  console.log('Authenticated successfully. Access token expires in %ss', authSession.expiresIn ?? 'unknown');

  const location = values.location
    ? values.location.split(',').map(c => parseFloat(c.trim()))
    : await retry(async () => await getLocation());
  console.log('Current location: %s, %s', ...location);

  console.log('Initial search radius: %s', humanDistance(distanceRadius));

  while (true) {
    const cars = await getCars(location);
    const filteredCars = cars
      .filter(car => car.distance <= distanceRadius)
      .sort((a, b) => a.distance - b.distance);

    console.log(
      '%i cars found. %i within %s. Waiting %i seconds',
      cars.length,
      filteredCars.length,
      humanDistance(distanceRadius),
      pause,
    );

    if (filteredCars.length) {
      const car = filteredCars[0];

      const nextSmallerRadius = distanceRadii.find(i => i < car.distance);

      const args = [
        '-u',
        'critical',
        '-t',
        '6000',
        '-p',
        '-A',
        'block=Block car',
        '-A',
        'stop=Stop looking',
        'Car found!',
        `${car.brand} ${car.model} is ${Math.floor(car.distance)}m away`,
      ];
      if (nextSmallerRadius) {
        args.push('-A', 'reduce=Reduce radius to ' + humanDistance(nextSmallerRadius));
      }
      if (notificationId) args.push('-r', notificationId);

      const res = spawnSync('notify-send', args);

      [notificationId, notifyResult] = res.stdout.toString().split('\n');
      if (notifyResult) notifyResult = notifyResult.trim();
      switch (notifyResult) {
        case 'block':
          try {
            const booking = await blockCar(car, authSession);
            console.log('Block request completed: %j', booking);
          } catch (err) {
            console.error('Failed to block car: %s', err.message);
          }
          break;
        case 'reduce':
          distanceRadius = nextSmallerRadius;
          break;
        case 'stop':
          process.exit();
      }
    }

    await wait(pause * 1000);
  }
}

//https://www.reservauto.net/WCF/LSI/LSIBookingServiceV3.svc/GetAvailableVehicles?BranchID=2&LanguageID=2
//https://www.reservauto.net/WCF/LSI/LSIBookingServiceV3.svc/GetAvailableVehicles?BranchID=2&LanguageID=2


async function getCars(location) {

  const url = `https://www.reservauto.net/WCF/LSI/LSIBookingServiceV3.svc/GetAvailableVehicles?BranchID=${branchId}&LanguageID=2`;

  if (process.env.DEBUG) {
    console.log('Url: %s', url);
  }

  const result = await retry(
    async () => await fetch(url),
  );
  const json = await result.json();
  return json.d.Vehicles.map( vehicle => ({
    id: vehicle.CarId,
    vin: vehicle.CarVin,
    brand: vehicle.CarBrand,
    model: vehicle.CarModel,
    plate: vehicle.CarPlate,
    color: vehicle.CarColor,
    lat: vehicle.Latitude,
    lng: vehicle.Longitude,
    cityId: vehicle.CityID,
    distance: calculateDistance(...location, vehicle.Latitude, vehicle.Longitude),
  }));

}

async function getLocation() {

  console.log('Getting current location');
  const result =
    execSync('/usr/libexec/geoclue-2.0/demos/where-am-i -t 6')
    .toString();

  const obj = Object.fromEntries(
    result.split('\n').map( line => line.split(':').map(k => k.trim()))
  );
  let lat = obj['Latitude']
  let lon = obj['Longitude']

  if (!lat) {
    const ipRes = await fetch("https://api.ipify.org?format=json")
    const { ip }= await ipRes.json();
    
    const locationRes = await fetch(`http://ip-api.com/json/${ip}`)
    const locationObj = await locationRes.json()
    
    lon = locationObj.lon;
    lat = locationObj.lat;

    if (lat && lon) {
      return [lat, lon]
    }
    throw new Error('Could not get location, try adding the location manaully with the --location arg');
  }

  return [lat, lon]

}

function calculateDistance(lat1, lng1, lat2, lng2) {

  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  const distance = earthRadius * c;

  return distance*1000;
}

function toRadians(degrees) {
  return degrees * (Math.PI / 180);
}

function wait(ms) {

  return new Promise(res => setTimeout(res, ms));

}

function humanDistance(inp) {

  if (inp < 1000) return inp + 'm';
  return (inp/1000) + 'km';

}

async function retry(cb, times = 3, delay = 1000) {

  try{
    return await cb();
  } catch (err) {

    if (times===0) {
      throw err;
    } else {
      console.warn('Function failed with error %s. Trying again in %s seconds', err, delay/1000)
      await wait(delay);
      return retry(cb, times-1, delay);
    }

  }

}

function parseRadius(input) {
  const trimmed = input.trim().toLowerCase();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(km|m)?$/);

  if (!match) {
    throw new Error(`Invalid radius value: ${input}`);
  }

  const value = parseFloat(match[1]);
  const unit = match[2] ?? 'm';

  const distanceInMeters = unit === 'km' ? value * 1000 : value;

  if (!Number.isFinite(distanceInMeters) || distanceInMeters <= 0) {
    throw new Error(`Radius must be a positive number. Received: ${input}`);
  }

  return Math.round(distanceInMeters);
}

async function login(username, password, branchId) {
  if (!username || !password) {
    throw new Error('Username and password are required for authentication.');
  }

  const tenant = branchTenants[branchId];
  if (!tenant) {
    throw new Error(`Unsupported branch ${branchId}.`);
  }

  const domain = branchDomains[branchId];
  if (!domain) {
    throw new Error(`Unable to resolve branch domain for ${branchId}.`);
  }

  const session = new HttpSession();
  const { verifier, challenge } = createPkcePair();
  const state = randomState();
  const redirectUri = `https://${domain}.client.reservauto.net/signin-callback?branchId=${branchId}`;

  const authorizeParams = new URLSearchParams({
    client_id: 'CustomerSpaceClient',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid profile reservautofrontofficerestapi communautorestapi offline_access',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    response_mode: 'query',
    ui_locales: 'en-ca',
    acr_values: `tenant:${branchId}`,
    branch_id: String(branchId),
  });

  let currentUrl = new URL(`https://foidentityprovider.reservauto.net/connect/authorize?${authorizeParams.toString()}`);
  let response = await session.fetch(currentUrl.toString(), { redirect: 'manual' });

  if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
    currentUrl = new URL(response.headers.get('location'), currentUrl);
    response = await session.fetch(currentUrl.toString(), { redirect: 'manual' });
  }

  let html = await response.text();
  if (!html || !/<form/i.test(html)) {
    throw new Error('Unable to load Communauto login form. Received unexpected content.');
  }

  let forms = parseHtmlForms(html);
  if (!forms.length) {
    throw new Error('Unable to parse Communauto login form.');
  }

  let emailForm = forms.find(form => /login/i.test(form.action ?? '') && !/password/i.test(form.action ?? '')) ?? forms[0];
  const emailFields = { ...emailForm.fields };
  setFirstExistingField(emailFields, ['Input.Email', 'Input.EmailAddress', 'Input.Username', 'Input.Login', 'Email', 'email', 'username'], username);
  setFirstExistingField(emailFields, ['Input.BranchId', 'Input.BranchID', 'Input.SelectedBranchId', 'BranchId', 'branchId'], tenant, { createIfMissing: true });
  setFirstExistingField(emailFields, ['Input.LoginType', 'LoginType'], '0');
  setFirstExistingField(emailFields, ['Input.RememberLogin', 'RememberLogin'], 'true');

  const emailAction = resolveFormAction(emailForm.action, currentUrl);

  response = await session.fetch(emailAction, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': currentUrl.toString(),
    },
    body: buildFormBody(emailFields).toString(),
  });

  currentUrl = new URL(emailAction);

  if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
    currentUrl = new URL(response.headers.get('location'), currentUrl);
    response = await session.fetch(currentUrl.toString(), { redirect: 'manual' });
  }

  html = await response.text();
  if (!html || !/<form/i.test(html)) {
    throw new Error('Unable to load Communauto password form.');
  }

  forms = parseHtmlForms(html);
  if (!forms.length) {
    throw new Error('Unable to parse Communauto password form.');
  }

  let passwordForm =
    forms.find(form => /password/i.test(form.action ?? '')) ??
    forms.find(form => /login/i.test(form.action ?? '')) ??
    forms[0];
  const passwordFields = { ...passwordForm.fields };
  setFirstExistingField(passwordFields, ['Input.Password', 'Password', 'password'], password);
  setFirstExistingField(passwordFields, ['Input.Email', 'Input.Username', 'Email', 'username'], username);
  if (!passwordFields['Input.BranchId'] && !passwordFields.BranchId) {
    setFirstExistingField(passwordFields, ['Input.BranchId', 'BranchId'], tenant, { createIfMissing: true });
  }

  const passwordAction = resolveFormAction(passwordForm.action, currentUrl);

  response = await session.fetch(passwordAction, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': currentUrl.toString(),
    },
    body: buildFormBody(passwordFields).toString(),
  });

  currentUrl = new URL(passwordAction);

  let authorizationUrl = null;

  for (let attempts = 0; attempts < 10; attempts += 1) {
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      const location = new URL(response.headers.get('location'), currentUrl);
      if (!authorizationUrl && location.searchParams.has('code')) {
        authorizationUrl = location;
      }
      response = await session.fetch(location.toString(), { redirect: 'manual' });
      currentUrl = location;
      if (authorizationUrl && authorizationUrl.searchParams.has('code')) {
        break;
      }
      continue;
    }

    const bodyText = await response.text();
    const redirectMatch = bodyText.match(/window\.location(?:\.href)?\s*=\s*['"]([^'"\s]+)['"]/i);
    if (redirectMatch) {
      const location = new URL(redirectMatch[1], currentUrl);
      if (!authorizationUrl && location.searchParams.has('code')) {
        authorizationUrl = location;
      }
      response = await session.fetch(location.toString(), { redirect: 'manual' });
      currentUrl = location;
      if (authorizationUrl && authorizationUrl.searchParams.has('code')) {
        break;
      }
      continue;
    }

    if (!authorizationUrl && currentUrl.searchParams.has('code')) {
      authorizationUrl = currentUrl;
    }
    break;
  }

  if (!authorizationUrl || !authorizationUrl.searchParams.has('code')) {
    throw new Error('Login flow did not yield an authorization code. Check credentials and branch selection.');
  }

  const authorizationCode = authorizationUrl.searchParams.get('code');
  const returnedState = authorizationUrl.searchParams.get('state');
  if (returnedState && returnedState !== state) {
    throw new Error('Authorization server returned an unexpected state parameter.');
  }

  const tokenResponse = await session.fetch('https://foidentityprovider.reservauto.net/connect/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      client_id: 'CustomerSpaceClient',
      grant_type: 'authorization_code',
      code: authorizationCode,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }).toString(),
  });

  if (!tokenResponse.ok) {
    const errorBody = await safeReadJson(tokenResponse);
    const errorMessage =
      errorBody?.error_description || errorBody?.error || errorBody?.raw || `status ${tokenResponse.status}`;
    throw new Error(`Token exchange failed: ${errorMessage}`);
  }

  const tokenBody = await tokenResponse.json();

  if (!tokenBody?.access_token) {
    throw new Error('Authorization server response did not include an access token.');
  }

  return {
    accessToken: tokenBody.access_token,
    refreshToken: tokenBody.refresh_token ?? null,
    expiresIn: tokenBody.expires_in ?? null,
    idToken: tokenBody.id_token ?? null,
    tokenType: tokenBody.token_type ?? 'Bearer',
  };
}

class HttpSession {
  constructor() {
    this.cookies = new Map();
  }

  async fetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = new Headers(init.headers ?? {});

    if (!headers.has('User-Agent')) {
      headers.set('User-Agent', userAgent);
    }
    if (!headers.has('Accept')) {
      headers.set('Accept', defaultHtmlAccept);
    }
    if (!headers.has('Accept-Language')) {
      headers.set('Accept-Language', defaultAcceptLanguage);
    }

    if (!headers.has('Cookie') && this.cookies.size) {
      headers.set('Cookie', this.serializeCookies());
    }

    const response = await fetch(url, { ...init, headers, redirect: init.redirect ?? 'follow' });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      this.storeCookies(setCookie);
    }
    return response;
  }

  storeCookies(header) {
    for (const entry of splitSetCookieHeader(header)) {
      const [name, ...rest] = entry.split('=');
      if (!name) continue;
      const value = rest.join('=');
      const trimmedName = name.trim();
      const trimmedValue = value.split(';')[0]?.trim() ?? '';
      if (trimmedName) {
        this.cookies.set(trimmedName, trimmedValue);
      }
    }
  }

  serializeCookies() {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }
}

function splitSetCookieHeader(header) {
  if (!header) return [];
  return header
    .split(/,(?=[^;,]+=)/g)
    .map(value => value.trim())
    .filter(Boolean);
}

function parseHtmlForms(html) {
  const forms = [];
  const formRegex = /<form\b[^>]*>[\s\S]*?<\/form>/gi;
  let match;
  while ((match = formRegex.exec(html))) {
    const formHtml = match[0];
    const actionMatch = formHtml.match(/action\s*=\s*["']([^"']*)["']/i);
    const methodMatch = formHtml.match(/method\s*=\s*["']([^"']*)["']/i);
    const fields = {};

    const inputRegex = /<input\b[^>]*>/gi;
    let inputMatch;
    while ((inputMatch = inputRegex.exec(formHtml))) {
      const inputTag = inputMatch[0];
      const nameMatch = inputTag.match(/name\s*=\s*["']([^"']+)["']/i);
      if (!nameMatch) continue;
      const valueMatch = inputTag.match(/value\s*=\s*["']([^"']*)["']/i);
      const typeMatch = inputTag.match(/type\s*=\s*["']([^"']*)["']/i);
      const isCheckbox = typeMatch ? /checkbox/i.test(typeMatch[1]) : false;
      const isRadio = typeMatch ? /radio/i.test(typeMatch[1]) : false;
      let value = valueMatch ? decodeHtmlEntities(valueMatch[1]) : '';
      if (!value && (isCheckbox || isRadio)) {
        const checked = /checked/i.test(inputTag);
        value = checked ? 'true' : '';
      }
      fields[nameMatch[1]] = value;
    }

    const selectRegex = /<select\b[^>]*name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/select>/gi;
    let selectMatch;
    while ((selectMatch = selectRegex.exec(formHtml))) {
      const [_, name, optionsHtml] = selectMatch;
      const selectedOption =
        optionsHtml.match(/<option[^>]*value\s*=\s*["']([^"']*)["'][^>]*selected[^>]*>/i) ||
        optionsHtml.match(/<option[^>]*value\s*=\s*["']([^"']*)["'][^>]*>/i);
      if (selectedOption) {
        fields[name] = decodeHtmlEntities(selectedOption[1]);
      }
    }

    forms.push({
      action: actionMatch ? decodeHtmlEntities(actionMatch[1]) : '',
      method: methodMatch ? methodMatch[1].toUpperCase() : 'GET',
      fields,
    });
  }
  return forms;
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function setFirstExistingField(fields, names, value, options = {}) {
  if (value == null) return;
  const { createIfMissing = false } = options;
  const stringValue = typeof value === 'string' ? value : String(value);
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(fields, name)) {
      fields[name] = stringValue;
      return;
    }
  }
  if (createIfMissing) {
    fields[names[0]] = stringValue;
  }
}

function resolveFormAction(action, currentUrl) {
  if (!action) {
    return currentUrl.toString();
  }
  const trimmed = action.trim();
  if (/^https?:/i.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith('//')) {
    return `${currentUrl.protocol}${trimmed}`;
  }
  return new URL(trimmed, currentUrl).toString();
}

function buildFormBody(fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    params.append(key, value ?? '');
  }
  return params;
}

function randomState(size = 32) {
  return toBase64Url(randomBytes(size));
}

function createPkcePair() {
  const verifier = toBase64Url(randomBytes(32));
  const challenge = toBase64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function toBase64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function safeReadJson(response) {
  try {
    return await response.clone().json();
  } catch (error) {
    try {
      const text = await response.clone().text();
      return text ? { raw: text } : null;
    } catch {
      return null;
    }
  }
}

async function blockCar(car, session) {
  if (!session?.accessToken) {
    throw new Error('Missing authenticated session.');
  }

  const payload = {
    vehicleId: car.id,
    branchId,
  };

  const response = await fetch('https://restapifrontoffice.reservauto.net/api/v2/Rental/FreeFloating', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Accept-Language': defaultAcceptLanguage,
      Authorization: `${session.tokenType ?? 'Bearer'} ${session.accessToken}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Booking request failed with status ${response.status}`);
  }

  const result = await response.json();

  if (!result || typeof result !== 'object') {
    throw new Error('Unexpected booking response.');
  }

  if (result.success === false || result.error || result.errorMessage || Array.isArray(result.errors)) {
    const message =
      result.errorMessage ||
      (Array.isArray(result.errors) ? result.errors.map(err => err.message ?? err).join('; ') : undefined) ||
      result.error ||
      'Unknown error';
    throw new Error(`Booking rejected: ${message}`);
  }

  return result;
}

async function resolveCredentials(values) {
  const filePath = values['auth-file'];
  let fileCredentials = {};

  if (filePath) {
    fileCredentials = await readCredentialsFile(filePath);
  }

  const username = values.username ?? fileCredentials.username;
  const password = values.password ?? fileCredentials.password;

  if (!username || !password) {
    if (filePath) {
      throw new Error(
        'Blocking a car requires both username and password provided either in the credentials file or via CLI flags.',
      );
    }
    throw new Error(
      'Blocking a car requires credentials. Provide --username/--password or use --auth-file <path>.',
    );
  }

  return { username, password };
}

async function readCredentialsFile(filePath) {
  let fileContents;
  try {
    fileContents = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read credentials file at ${filePath}: ${error.message}`);
  }

  let parsed = {};
  try {
    parsed = JSON.parse(fileContents);
  } catch (error) {
    parsed = parseCredentialFallback(fileContents);
    if (!parsed) {
      throw new Error(
        `Credentials file ${filePath} must be JSON or key=value pairs containing username/password. ${error.message}`,
      );
    }
  }

  const username = parsed.username ?? parsed.user ?? parsed.email ?? parsed.login ?? parsed.USERNAME ?? parsed.EMAIL;
  const password = parsed.password ?? parsed.pass ?? parsed.PASSWORD ?? parsed.PASS;

  if (!username || !password) {
    throw new Error(
      `Credentials file ${filePath} is missing required "username" and "password" values.`,
    );
  }

  return {
    username: String(username).trim(),
    password: String(password).trim(),
  };
}

function parseCredentialFallback(contents) {
  const lines = contents
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return null;
  }

  const data = {};

  for (const line of lines) {
    const match = line.match(/^(\w+)[\s:=]+(.+)$/);
    if (match) {
      const [, key, value] = match;
      data[key] = value.trim();
    }
  }

  if (!data.username && !data.user && !data.email && lines.length >= 2 && !lines[0].includes('=') && !lines[0].includes(':')) {
    [data.username, data.password] = lines.slice(0, 2);
  }

  return Object.keys(data).length ? data : null;
}


await main();
