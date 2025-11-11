# Communauto FrontOffice API Notes

## Swagger entry points
- The Communauto front office exposes a Swagger UI at `https://restapifrontoffice.reservauto.net/ReservautoFrontOffice/index.html`, which lists JSON specs for modules such as General, Vehicle, Station, and Rental.

## Authentication requirements
- The `Rental v2` specification declares an OAuth2 `authorizationCode` flow named `BearerDefinition` with authorize URL `https://foidentityprovider.reservauto.net/connect/authorize`, token URL `https://foidentityprovider.reservauto.net/connect/token`, and scope `reservautofrontofficerestapi`. Accessing protected endpoints (including the rental operations) therefore requires logging in through this flow.

```json
"securitySchemes": {
  "BearerDefinition": {
    "type": "oauth2",
    "flows": {
      "authorizationCode": {
        "authorizationUrl": "https://foidentityprovider.reservauto.net/connect/authorize",
        "tokenUrl": "https://foidentityprovider.reservauto.net/connect/token",
        "scopes": {
          "reservautofrontofficerestapi": "Access to Reservauto FrontOffice RestAPI"
        }
      }
    }
  }
}
```

## Availability lookups
- Vehicle availability is published through endpoints such as `GET /api/v2/Vehicle/FreeFloatingAvailability` (for Flex cars) and `GET /api/v2/StationAvailability` (for station-based inventory). These are defined in the `Vehicle v2` and `Station v2` Swagger specs and accept city and bounding box filters.

## Rental workflow details
- Before starting a rental, `GET /api/v2/Rental/Notification` returns any warnings that must be acknowledged. The request expects a branch ID and optional language header.
- The rental spec exposes request DTOs even when the operation paths are hidden. For a free-floating block, `RentalFreeFloatingCreateDTO` shows that the POST body only needs the target `vehicleId`.

```json
"RentalFreeFloatingCreateDTO": {
  "type": "object",
  "properties": {
    "vehicleId": {
      "type": "integer",
      "format": "int32"
    }
  },
  "additionalProperties": false
}
```
- For a station-based reservation (which also blocks the vehicle), `RentalStationBasedCreateDTO` requires the vehicle ID plus start/end timestamps and any accessory or promotion selections. The spec references helper endpoints (`Vehicle/AvailableAccessory`, `Vehicle/AvailablePromotionType`, `Vehicle/AvailableTrait`) for the identifier lists.

```json
"RentalStationBasedCreateDTO": {
  "type": "object",
  "properties": {
    "vehicleId": { "type": "integer", "format": "int32" },
    "startDate": { "type": "string", "format": "date-time" },
    "endDate": { "type": "string", "format": "date-time" },
    "vehicleAccessories": { "type": "array", "items": { "type": "integer", "format": "int32" }, "nullable": true },
    "vehiclePromotions": { "type": "array", "items": { "type": "integer", "format": "int32" }, "nullable": true },
    "vehicleTypes": { "type": "array", "items": { "type": "integer", "format": "int32" }, "nullable": true },
    "vehicleBodyTypes": { "type": "array", "items": { "type": "integer", "format": "int32" }, "nullable": true },
    "vehiclePropulsionTypes": { "type": "array", "items": { "type": "integer", "format": "int32" }, "nullable": true },
    "vehicleTransmissionTypes": { "type": "array", "items": { "type": "integer", "format": "int32" }, "nullable": true },
    "vehicleTireTypes": { "type": "array", "items": { "type": "integer", "format": "int32" }, "nullable": true },
    "customerNote": { "type": "string", "nullable": true }
  },
  "additionalProperties": false
}
```
- `RentalActionCreateDTO` together with the `ERentalAction` enum documents the follow-up actions you can POST, including `ExtendFreeFloatingVehicleBlocking`, `UnlockDoors`, and `CancelRental`, which indicates how to extend or release a block once you have a rental token.

```json
"ERentalAction": {
  "enum": [
    "Unknown",
    "AccessVehicle",
    "EndRental",
    "CancelRental",
    "ModifyRental",
    "LocateVehicle",
    "ActivateGasCreditCard",
    "ViewPurchaseReceipt",
    "UploadPurchaseReceipt",
    "UnlockDoors",
    "ParkingMeter",
    "ActivateRebatePassUsage",
    "Report",
    "ExtendFreeFloatingVehicleBlocking",
    "ShareRental"
  ],
  "type": "string"
}
```

## Feature gating
- `GET /api/v2/AvailableFeature` returns which capabilities the current account or branch supports; the `EAvailableFeatureType` enum includes `CreateStationBasedReservation`, so blocking may be disallowed if this flag is absent.

```json
"EAvailableFeatureType": {
  "enum": [
    "Unknown",
    "CreateStationBasedReservation",
    "ViewAccountManagement",
    "ViewContactCompany",
    "ViewPartnerOffers",
    "ViewReservationList",
    "ViewSelectLanguage",
    "ViewPaymentMethod",
    "ViewAccessCard",
    "ViewEmergencyContact",
    "ViewPreferences",
    "ViewTransactionList",
    "ViewMonthlyInvoice",
    "ViewPlan",
    "ViewProtectionPlan",
    "ViewRentalCredit",
    "ViewFreeFloatingPass",
    "ViewChangePassword"
  ],
  "type": "string"
}
```

## Summary of prerequisites to block a car
1. Authenticate through the OAuth2 authorization-code flow to obtain a bearer token with the `reservautofrontofficerestapi` scope.
2. Confirm the account has the `CreateStationBasedReservation` (station) or equivalent free-floating privileges via `GET /api/v2/AvailableFeature`.
3. Use the availability endpoints to pick a `vehicleId`, then submit a POST body that matches either `RentalFreeFloatingCreateDTO` (flex block) or `RentalStationBasedCreateDTO` (station block).
4. Handle any `Rental/Notification` warnings and use `RentalAction` endpoints like `ExtendFreeFloatingVehicleBlocking` to keep the hold active as needed.
