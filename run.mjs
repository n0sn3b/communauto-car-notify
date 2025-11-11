#!/usr/bin/env node
import { execSync, spawnSync } from 'child_process';
import { readFile } from 'fs/promises';
import { parseArgs } from 'util';

const branchIds = {
  montreal: 1,
  quebec: 2,
  toronto: 3,
};

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
  -F, --auth-file <path>  Path to JSON credentials file with "username" and "password"
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

const customRadius = values.radius ? parseRadius(values.radius) : undefined;

let distanceRadius = customRadius ?? defaultRadius;

let notificationId, notifyResult;

if (!branchIds[values.city]) {
  throw new Error(`City ${values.city} not yet supported! File a bug`);
}
const branchId = branchIds[values.city];

console.log('Using City Branch: %s. Branch ID: %i', values.city, branchId);


const credentials = await resolveCredentials(values);

const authSession = await login(credentials.username, credentials.password, branchId);

console.log('Authenticated successfully. Customer ID: %s', authSession.customerId);

const location = values.location ? values.location.split(',').map(c => parseFloat(c.trim())) : await retry(async () => await getLocation())
console.log('Current location: %s, %s', ...location);

console.log('Initial search radius: %s', humanDistance(distanceRadius));



while(true) {
  const cars = await getCars(location);
  const filteredCars = cars
    .filter(car => car.distance <= distanceRadius)
    .sort((a,b) => a.distance - b.distance);

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
      '-t', '6000',
      '-p',
      '-A', 'block=Block car',
      '-A', 'stop=Stop looking',
      'Car found!',
      `${car.brand} ${car.model} is ${Math.floor(car.distance)}m away`
    ];
    if (nextSmallerRadius) {
      args.push('-A', 'reduce=Reduce radius to ' + humanDistance(nextSmallerRadius));
    }
    if (notificationId) args.push('-r', notificationId);

    const res = spawnSync('notify-send', args);

    [notificationId, notifyResult] = res.stdout.toString().split('\n');
    if (notifyResult) notifyResult = notifyResult.trim();
    switch(notifyResult) {
      case 'block':
        try {
          const booking = await blockCar(car, authSession);
          console.log('Block request completed: %j', booking);
        } catch (err) {
          console.error('Failed to block car: %s', err.message);
        }
        break;
      case 'reduce' :
        distanceRadius = nextSmallerRadius;
        break;
      case 'stop':
        process.exit();
    }

  }

  await wait(pause * 1000);

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
  const url = new URL('https://www.reservauto.net/Scripts/Client/Ajax/Mobile/Login.asp');
  url.searchParams.set('BranchID', branchId);
  url.searchParams.set('Username', username);
  url.searchParams.set('Password', password);
  url.searchParams.set('RememberMe', 'true');

  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Login request failed with status ${response.status}`);
  }

  const sessionCookie = extractSessionCookie(response.headers.get('set-cookie'));

  const body = await response.json();
  const account = body?.data?.[0];

  if (!account || !account.CustomerID) {
    throw new Error('Invalid Communauto credentials.');
  }

  return {
    customerId: account.CustomerID,
    providerNo: account.ProviderNo,
    cityId: account.CityID ? parseInt(account.CityID, 10) : undefined,
    cookie: sessionCookie,
  };
}

async function blockCar(car, session) {
  if (!session?.customerId) {
    throw new Error('Missing authenticated session.');
  }

  const payload = {
    CustomerID: session.customerId,
    CarID: car.id,
    CarVIN: car.vin,
    BranchID: branchId,
    CityID: session.cityId ?? car.cityId ?? null,
  };

  const response = await fetch('https://www.reservauto.net/WCF/LSI/LSIBookingServiceV3.svc/CreateBookingPost', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(session.cookie ? { Cookie: session.cookie } : {}),
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

  const booking = result.d ?? result;

  if (booking?.Success === false || booking?.CreateBookingError) {
    const errorMessage = booking.ErrorMessage || booking.CreateBookingError || 'Unknown error';
    throw new Error(`Booking rejected: ${errorMessage}`);
  }

  return booking;
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

  let parsed;
  try {
    parsed = JSON.parse(fileContents);
  } catch (error) {
    throw new Error(
      `Credentials file ${filePath} must be valid JSON containing "username" and "password" fields. ${error.message}`,
    );
  }

  const username = parsed.username ?? parsed.user ?? parsed.email;
  const password = parsed.password ?? parsed.pass;

  if (!username || !password) {
    throw new Error(
      `Credentials file ${filePath} is missing required "username" and "password" values.`,
    );
  }

  return {
    username: String(username),
    password: String(password),
  };
}

function extractSessionCookie(header) {
  if (!header) return undefined;

  const firstCookie = header.split(/,(?=[^;,]+=)/)[0] ?? header;
  return firstCookie.split(';')[0];
}
