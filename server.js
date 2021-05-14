"use strict";

const MQTT = require("async-mqtt");
const util = require("util");
const exec = util.promisify(require("child_process").exec);
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

main();

async function main() {
  try {
    process.stdout.write("Connecting...");
    let options;
    console.log(argv.password);
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

    while (true) {
      process.stdout.write("Updating...");

      const cpu = await getCPUTemperatureAndFans();
      await client.publish("laptop/cpu", JSON.stringify(cpu));

      const camera = await getCamera();
      await client.publish("laptop/camera", JSON.stringify(camera));

      const microphone = await getMicrophone();
      await client.publish("laptop/microphone", JSON.stringify(microphone));

      const memory = await getMemory();
      await client.publish("laptop/memory", JSON.stringify(memory));

      const disk = await getDiskUsage();
      await client.publish("laptop/disk", JSON.stringify(disk));

      process.stdout.write("Done!\n");
      await sleep(10);
    }
  } catch (error) {
    process.stdout.write("Failed!\n\n");
    console.log(error.message);
  }
}

const cpuRegex = /^Package id 0:\s+\+([\d\.]+)/;
const coreRegex = /^Core (\d+):\s+\+([\d\.]+)/;
const fanRegex = /^fan(\d+):\s+([\d\.]+)/;
async function getCPUTemperatureAndFans() {
  const { stdout, stderr } = await exec("sensors -f");
  if (stderr.length > 0) {
    throw new Error(stderr);
  }

  const result = {
    temp: 0,
    coreTemps: [],
    fanSpeeds: [],
  };

  const lines = stdout.split(/\r?\n/);
  let match;
  for (const line of lines) {
    if ((match = line.match(cpuRegex))) {
      result.temp = Number(match[1]);
    } else if ((match = line.match(coreRegex))) {
      result.coreTemps[Number(match[1])] = Number(match[2]);
    } else if ((match = line.match(fanRegex))) {
      result.fanSpeeds[Number(match[1]) - 1] = Number(match[2]);
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

  const result = {
    active: false,
  };

  const match = stdout.match(cameraRegex);
  if (match) {
    result.active = Number(match[1]) > 0;
  }

  return result;
}

async function getMicrophone() {
  try {
    const { stdout, stderr } = await exec(
      "grep RUNNING /proc/asound/card*/pcm*c/sub*/status"
    );
    if (stderr.length > 0) {
      throw new Error(stderr);
    }

    return {
      active: stdout.length > 0,
    };
  } catch (error) {
    if (error.code === 1) {
      return {
        active: false,
      };
    }
    throw new Error(error);
  }
}

const memoryRegex =
  /^Mem:\s+(?<total>\d+)\s+(?<used>\d+)\s+(?<free>\d+)\s+(?<shared>\d+)\s+(?<cache>\d+)/m;
async function getMemory() {
  const { stdout, stderr } = await exec("free");
  if (stderr.length > 0) {
    throw new Error(stderr);
  }

  const result = {
    total: 0,
    used: 0,
    free: 0,
    shared: 0,
    cache: 0,
  };

  const match = stdout.match(memoryRegex);
  if (match) {
    for (const key in result) {
      result[key] = Number(match.groups[key]);
    }
  }

  return result;
}

const diskUsageRegex = /^(?<used>\d+)\s+(?<free>\d+)/m;
async function getDiskUsage() {
  const { stdout, stderr } = await exec("df --output=used,avail /");
  if (stderr.length > 0) {
    throw new Error(stderr);
  }

  const result = {
    total: 0,
    used: 0,
    free: 0,
  };

  const match = stdout.match(diskUsageRegex);
  if (match) {
    for (const key in result) {
      result[key] = Number(match.groups[key]);
    }
    result.total = result.used + result.free;
  }

  return result;
}

function sleep(seconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
}
