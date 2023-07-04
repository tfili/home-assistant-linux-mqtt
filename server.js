"use strict";

const crypto = require("crypto");
const MQTT = require("async-mqtt");
const moment = require("moment");
const os = require("os");
const util = require("util");
const exec = util.promisify(require("child_process").exec);
const { default: SysTray } = require("systray2");
const yargs = require("yargs");

const argv = yargs
  .options({
    server: {
      alias: "s",
      description: "Address of MQTT Server",
      type: "string",
      demand: true,
    },
    port: {
      alias: "p",
      description: "Port of MQTT Server",
      type: "number",
      default: 1883,
    },
    name: {
      alias: "n",
      description: "Name of the device to prefix the entities",
      type: "string",
      default: os.hostname(),
    },
    user: {
      alias: "u",
      description: "Username used to authenticate to the MQTT Server",
      type: "string",
    },
    password: {
      alias: "w",
      description: "Password used to authenticate to the MQTT Server",
      type: "string",
    },
  })
  .implies("user", "password").argv;

const uniqueId = crypto.createHash("md5").update(os.hostname()).digest("hex");
const baseTopic = "homeassistant";
const baseName = argv.name;
let activePromise;

main();

async function main() {
  try {
    process.stdout.write("Connecting...");
    let options;
    if (argv.user) {
      options = {
        username: argv.user,
        password: argv.password,
      };
    }
    const client = await MQTT.connectAsync(
      `mqtt://${argv.server}:${argv.port}`,
      options
    );
    process.stdout.write("Done!\n");

    await setupSystray();

    //eslint-disable-next-line no-constant-condition
    while (true) {
      await activePromise;

      process.stdout.write("Updating...");

      const cpu = await getCPUTemperatureAndFans();
      await client.publish(cpu.stateTopic, state(cpu.state));
      await client.publish(cpu.configTopic, JSON.stringify(cpu.config));
      await client.publish(cpu.attributesTopic, JSON.stringify(cpu.attributes));

      const camera = await getCamera();
      await client.publish(camera.stateTopic, state(camera.state));
      await client.publish(camera.configTopic, JSON.stringify(camera.config));

      const microphone = await getMicrophone();
      await client.publish(microphone.stateTopic, state(microphone.state));
      await client.publish(
        microphone.configTopic,
        JSON.stringify(microphone.config)
      );

      const uptime = await getUptime();
      await client.publish(uptime.stateTopic, state(uptime.state));
      await client.publish(uptime.configTopic, JSON.stringify(uptime.config));
      await client.publish(
        uptime.attributesTopic,
        JSON.stringify(uptime.attributes)
      );

      //   const memory = await getMemory();
      //   await client.publish("laptop/memory", JSON.stringify(memory));

      //   const disk = await getDiskUsage();
      //   await client.publish("laptop/disk", JSON.stringify(disk));

      process.stdout.write("Done!\n");
      await sleep(10);
    }
  } catch (error) {
    process.stdout.write("Failed!\n\n");
    console.log(error.message);
  }
}

async function setupSystray() {
  //eslint-disable-next-line prefer-const
  let systray;
  let resolve;
  const activeItem = {
    title: "Active",
    tooltip: "Sending to Home Assitant",
    checked: false,
    enabled: true,
    click: () => {
      activeItem.checked = !activeItem.checked;
      systray.sendAction({
        type: "update-item",
        item: activeItem,
      });

      if (activeItem.checked) {
        resolve();
        resolve = undefined;
      } else {
        // Inactive
        if (resolve) {
          resolve(); // Just in case
        }
        activePromise = new Promise((res) => {
          resolve = res;
        });
      }
    },
  };

  const itemExit = {
    title: "Exit",
    tooltip: "bb",
    checked: false,
    enabled: true,
    click: () => systray.kill(false),
  };

  systray = new SysTray({
    menu: {
      icon: "./images/ha.png",
      title: "Home Assistant Status",
      tooltip: "Exposes computer information to Home Assistant via MQTT",
      items: [activeItem, SysTray.separator, itemExit],
    },
    debug: false,
    copyDir: false,
  });

  systray.onClick((action) => {
    if (action.item.click !== null) {
      action.item.click();
    }
  });

  await systray.ready();

  activePromise = new Promise((res) => {
    resolve = res;
  });
}

const cpuRegex = /^Package id 0:\s+\+([\d\.]+)/;
const coreRegex = /^Core (\d+):\s+\+([\d\.]+)/;
const fanRegex = /^fan(\d+):\s+([\d\.]+)/;
async function getCPUTemperatureAndFans() {
  const { stdout, stderr } = await exec("sensors -f");
  if (stderr.length > 0) {
    throw new Error(stderr);
  }

  const stateTopic = `${baseTopic}/sensor/${uniqueId}/cpu_temperature/state`;
  const attributesTopic = `${baseTopic}/sensor/${uniqueId}/cpu_temperature/attributes`;
  const result = {
    state: 0,
    stateTopic,
    config: {
      name: `${baseName} CPU Temperature`,
      device_class: "temperature",
      state_topic: stateTopic,
      json_attributes_topic: attributesTopic,
      unique_id: `${uniqueId}-cpu_temperature`,
      unit_of_measurement: "°F",
    },
    configTopic: `${baseTopic}/sensor/${uniqueId}/cpu_temperature/config`,
    attributes: {
      coreTemps: [],
      fanSpeeds: [],
    },
    attributesTopic,
  };

  const lines = stdout.split(/\r?\n/);
  let match;
  for (const line of lines) {
    if ((match = line.match(cpuRegex))) {
      result.state = Number(match[1]);
    } else if ((match = line.match(coreRegex))) {
      result.attributes.coreTemps[Number(match[1])] = Number(match[2]);
    } else if ((match = line.match(fanRegex))) {
      result.attributes.fanSpeeds[Number(match[1]) - 1] = Number(match[2]);
    }
  }

  return result;
}

const cameraRegex = /^uvcvideo\s+\d+\s+(\d+)/;
async function getCamera() {
  const { stdout, stderr } = await exec("lsmod | grep uvcvideo");
  if (stderr.length > 0) {
    throw new Error(stderr);
  }

  const stateTopic = `${baseTopic}/binary_sensor/${uniqueId}/camera/state`;
  const result = {
    state: false,
    stateTopic,
    config: {
      name: `${baseName} Camera`,
      device_class: "connectivity",
      state_topic: stateTopic,
      unique_id: `${uniqueId}-camera`,
      icon: "mdi:camera",
    },
    configTopic: `${baseTopic}/binary_sensor/${uniqueId}/camera/config`,
  };

  const match = stdout.match(cameraRegex);
  if (match) {
    result.state = Number(match[1]) > 0;
  }

  return result;
}

async function getMicrophone() {
  const stateTopic = `${baseTopic}/binary_sensor/${uniqueId}/microphone/state`;
  const result = {
    state: false,
    stateTopic,
    config: {
      name: `${baseName} Microphone`,
      device_class: "connectivity",
      state_topic: stateTopic,
      unique_id: `${uniqueId}-microphone`,
      icon: "mdi:microphone",
    },
    configTopic: `${baseTopic}/binary_sensor/${uniqueId}/microphone/config`,
  };

  try {
    const { stdout, stderr } = await exec(
      "grep RUNNING /proc/asound/card*/pcm*c/sub*/status"
    );
    if (stderr.length > 0) {
      throw new Error(stderr);
    }

    result.state = stdout.length > 0;
  } catch (error) {
    if (error.code !== 1) {
      throw new Error(error);
    }
  }

  return result;
}

// const memoryRegex =
//   /^Mem:\s+(?<total>\d+)\s+(?<used>\d+)\s+(?<free>\d+)\s+(?<shared>\d+)\s+(?<cache>\d+)/m;
// async function getMemory() {
//   const { stdout, stderr } = await exec("free");
//   if (stderr.length > 0) {
//     throw new Error(stderr);
//   }

//   const result = {
//     total: 0,
//     used: 0,
//     free: 0,
//     shared: 0,
//     cache: 0,
//   };

//   const match = stdout.match(memoryRegex);
//   if (match) {
//     for (const key in result) {
//       if (result.hasOwnProperty(key)) {
//         result[key] = Number(match.groups[key]);
//       }
//     }
//   }

//   return result;
// }

// const diskUsageRegex = /^(?<used>\d+)\s+(?<free>\d+)/m;
// async function getDiskUsage() {
//   const { stdout, stderr } = await exec("df --output=used,avail /");
//   if (stderr.length > 0) {
//     throw new Error(stderr);
//   }

//   const result = {
//     total: 0,
//     used: 0,
//     free: 0,
//   };

//   const match = stdout.match(diskUsageRegex);
//   if (match) {
//     for (const key in result) {
//       if (result.hasOwnProperty(key)) {
//         result[key] = Number(match.groups[key]);
//       }
//     }
//     result.total = result.used + result.free;
//   }

//   return result;
// }

async function getUptime() {
  const { stdout, stderr } = await exec("cat /proc/uptime");
  if (stderr.length > 0) {
    throw new Error(stderr);
  }

  const seconds = stdout.split(/\s+/)[0];
  const attributes = moment.duration(seconds, "seconds");

  const stateTopic = `${baseTopic}/sensor/${uniqueId}/uptime/state`;
  const attributesTopic = `${baseTopic}/sensor/${uniqueId}/uptime/attributes`;
  const result = {
    state: Math.floor(seconds * 1000),
    stateTopic,
    config: {
      name: `${baseName} Uptime`,
      state_topic: stateTopic,
      json_attributes_topic: attributesTopic,
      unique_id: `${uniqueId}-uptime`,
      unit_of_measurement: "milliseconds",
    },
    configTopic: `${baseTopic}/sensor/${uniqueId}/uptime/config`,
    attributes: attributes._data,
    attributesTopic,
  };

  return result;
}

function state(s) {
  if (typeof s === "boolean") {
    return s ? "ON" : "OFF";
  }

  return s.toString();
}

function sleep(seconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
}
