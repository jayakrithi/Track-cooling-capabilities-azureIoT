"use strict";
const chalk = require('chalk');

// Use the Azure IoT device SDK for devices that connect to Azure IoT Central. 
var iotHubTransport = require('azure-iot-device-mqtt').Mqtt;
var Client = require('azure-iot-device').Client;
var Message = require('azure-iot-device').Message;
var ProvisioningTransport = require('azure-iot-provisioning-device-mqtt').Mqtt;
var SymmetricKeySecurityClient = require('azure-iot-security-symmetric-key').SymmetricKeySecurityClient;
var ProvisioningDeviceClient = require('azure-iot-provisioning-device').ProvisioningDeviceClient;
var provisioningHost = 'global.azure-devices-provisioning.net';

// Enter your Azure IoT keys.
var idScope = '0ne003B2500';
var registrationId = 'RefrigeratedTruck-001';
var symmetricKey = 'ikMeiWXS+6AJHTRC38sllUfeKID0EfGX5PHrWw1/jbA='; // Key for Truck 1

var provisioningSecurityClient = new SymmetricKeySecurityClient(registrationId, symmetricKey);
var provisioningClient = ProvisioningDeviceClient.create(provisioningHost, idScope, new ProvisioningTransport(), provisioningSecurityClient);
var hubClient;

var truckIdentification = "Truck number 1";

var rest = require("azure-maps-rest");

// Enter your Azure Maps key.
var subscriptionKeyCredential = new rest.SubscriptionKeyCredential("v6VOoGQpSx1XfIqbwTB0Vp0g1ZTE4tRzMLnl8Izle74");

// Azure Maps connection 
var pipeline = rest.MapsURL.newPipeline(subscriptionKeyCredential);
var routeURL = new rest.RouteURL(pipeline);

function greenMessage(text) {
    console.log(chalk.green(text) + "\n");
}
function redMessage(text) {
    console.log(chalk.red(text) + "\n");
}

// Truck globals initialized to the starting state of the truck. 
// Enums, frozen name:value pairs. 
var stateEnum = Object.freeze({ "ready": "ready", "enroute": "enroute", "delivering": "delivering", "returning": "returning", "loading": "loading", "dumping": "dumping" });
var contentsEnum = Object.freeze({ "full": "full", "melting": "melting", "empty": "empty" });
var fanEnum = Object.freeze({ "on": "on", "off": "off", "failed": "failed" });
const deliverTime = 600; // Time to complete delivery, in seconds. 
const loadingTime = 800; // Time to load contents. 
const dumpingTime = 400; // Time to dump melted contents. 
const tooWarmThreshold = 2; // Degrees C temperature that is too warm for contents. 
const tooWarmtooLong = 60; // Time in seconds for contents to start melting if temperatures are above threshold. 
var timeOnCurrentTask = 0; // Time on current task, in seconds. 
var interval = 60; // Time interval in seconds. 
var tooWarmPeriod = 0; // Time that contents are too warm, in seconds. 
var temp = -2; // Current temperature of contents, in degrees C. 
var baseLat = 47.644702; // Base position latitude. 
var baseLon = -122.130137; // Base position longitude. 
var currentLat = baseLat; // Current position latitude. 
var currentLon = baseLon; // Current position longitude. 
var destinationLat; // Destination position latitude. 
var destinationLon; // Destination position longitude. 
var fan = fanEnum.on; // Cooling fan state. 
var contents = contentsEnum.full; // Truck contents state. 
var state = stateEnum.ready; // Truck is full and ready to go! 
var optimalTemperature = -5; // Setting - can be changed by the operator from IoT Central.
var outsideTemperature = 12; // Ambient outside temperature.
const noEvent = "none";
var eventText = noEvent; // Text to send to the IoT operator. 
var customer = [ // Latitude and longitude position of customers. 

    // Gasworks Park 
    [47.645892, -122.336954],

    // Golden Gardens Park 
    [47.688741, -122.402965],

    // Seward Park 
    [47.551093, -122.249266],

    // Lake Sammamish Park 
    [47.555698, -122.065996],

    // Marymoor Park 
    [47.663747, -122.120879],

    // Meadowdale Beach Park 
    [47.857295, -122.316355],

    // Lincoln Park 
    [47.530250, -122.393055],

    // Gene Coulon Park 
    [47.503266, -122.200194],

    // Luther Bank Park 
    [47.591094, -122.226833],

    // Pioneer Park 
    [47.544120, -122.221673]
];
var path = []; // Latitude and longitude steps for the route. 
var timeOnPath = []; // Time in seconds for each section of the route. 
var truckOnSection; // The current path section the truck is on. 
var truckSectionsCompletedTime; // The time the truck has spent on previous completed sections.

function Degrees2Radians(deg) {
    return deg * Math.PI / 180;
}

function DistanceInMeters(lat1, lon1, lat2, lon2) {
    var dlon = Degrees2Radians(lon2 - lon1);
    var dlat = Degrees2Radians(lat2 - lat1);
    var a = (Math.sin(dlat / 2) * Math.sin(dlat / 2)) + Math.cos(Degrees2Radians(lat1)) * Math.cos(Degrees2Radians(lat2)) * (Math.sin(dlon / 2) * Math.sin(dlon / 2));
    var angle = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    var meters = angle * 6371000;
    return meters;
}

function Arrived() {

    // If the truck is within 10 meters of the destination, call it good. 
    if (DistanceInMeters(currentLat, currentLon, destinationLat, destinationLon) < 10)
        return true;
    return false;
}

function UpdatePosition() {
    while ((truckSectionsCompletedTime + timeOnPath[truckOnSection] < timeOnCurrentTask) && (truckOnSection < timeOnPath.length - 1)) {
        // Truck has moved on to the next section. 
        truckSectionsCompletedTime += timeOnPath[truckOnSection];
        ++truckOnSection;
    }

    // Ensure remainder is less than or equal to 1, because the interval may take count over what is needed. 
    var remainderFraction = Math.min(1, (timeOnCurrentTask - truckSectionsCompletedTime) / timeOnPath[truckOnSection]);

    // The path should be one entry longer than the timeOnPath array. 
    // Find how far along the section the truck has moved. 
    currentLat = path[truckOnSection][0] + remainderFraction * (path[truckOnSection + 1][0] - path[truckOnSection][0]);
    currentLon = path[truckOnSection][1] + remainderFraction * (path[truckOnSection + 1][1] - path[truckOnSection][1]);
}

function GetRoute(newState) {

    // Set the state to ready, until the new route arrives. 
    state = stateEnum.ready;

    // Coordinates are in longitude first. 
    var coordinates = [
        [currentLon, currentLat],
        [destinationLon, destinationLat]
    ];
    var results = routeURL.calculateRouteDirections(rest.Aborter.timeout(10000), coordinates);
    results.then(data => {
        greenMessage("Route found. Number of points = " + JSON.stringify(data.routes[0].legs[0].points.length, null, 4));

        // Clear the path. 
        path.length = 0;

        // Start with the current location. 
        path.push([currentLat, currentLon]);

        // Retrieve the route and push the points onto the array. 
        for (var n = 0; n < data.routes[0].legs[0].points.length; n++) {
            var x = data.routes[0].legs[0].points[n].latitude;
            var y = data.routes[0].legs[0].points[n].longitude;
            path.push([x, y]);
        }

        // Finish with the destination. 
        path.push([destinationLat, destinationLon]);

        // Store the path length and the time taken to calculate the average speed. 
        var meters = data.routes[0].summary.lengthInMeters;
        var seconds = data.routes[0].summary.travelTimeInSeconds;
        var pathSpeed = meters / seconds;
        var distanceApartInMeters;
        var timeForOneSection;

        // Clear the time on the path array. 
        timeOnPath.length = 0;

        // Calculate how much time is required for each section of the path. 
        for (var t = 0; t < path.length - 1; t++) {

            // Calculate the distance between the two path points, in meters. 
            distanceApartInMeters = DistanceInMeters(path[t][0], path[t][1], path[t + 1][0], path[t + 1][1]);

            // Calculate the time for each section of the path. 
            timeForOneSection = distanceApartInMeters / pathSpeed;
            timeOnPath.push(timeForOneSection);
        }
        truckOnSection = 0;
        truckSectionsCompletedTime = 0;
        timeOnCurrentTask = 0;

        // Update the state now that the route has arrived, either enroute or returning. 
        state = newState;
    }, reason => {

        // Error: The request was aborted. 
        redMessage(reason);
        eventText = "Failed to find map route";
    });
}

function CmdGoToCustomer(request, response) {

    // Pick up a variable from the request payload. 
    var num = request.payload;

    // Check for valid customer ID. 
    if (num >= 0 && num < customer.length) {
        switch (state) {
            case stateEnum.dumping:
            case stateEnum.loading:
            case stateEnum.delivering:
                eventText = "Unable to act - " + state;
                break;
            case stateEnum.ready:
            case stateEnum.enroute:
            case stateEnum.returning:
                if (contents === contentsEnum.empty) {
                    eventText = "Unable to act - empty";
                }
                else {

                    // Set new customer event only when all is good. 
                    eventText = "New customer: " + num.toString();
                    destinationLat = customer[num][0];
                    destinationLon = customer[num][1];

                    // Find route from current position to destination, and store route. 
                    GetRoute(stateEnum.enroute);
                }
                break;
        }
    }
    else {
        eventText = "Invalid customer: " + num;
    }

    // Acknowledge the command. 
    response.send(200, 'Success', function (errorMessage) {

        // Failure 
        if (errorMessage) {
            redMessage('Failed sending a CmdGoToCustomer response:\n' + errorMessage.message);
        }
    });
}