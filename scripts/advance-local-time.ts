import { time } from "@nomicfoundation/hardhat-network-helpers";
import { ethers, network } from "hardhat";
import deploy from "./local-deploy-const";

const SECONDS_IN_DAY = 24 * 60 * 60;

function getFlags(): { [key: string]: string | boolean } {
    // Get the command line arguments
    const args = process.argv.slice(2);

    // Create an object to store flag-value pairs
    const flags: { [key: string]: string | boolean } = {};

    // Iterate through the arguments and parse flags
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        // Check if the argument is a flag (starts with '--')
        if (arg.startsWith("--")) {
            // Get the flag name (remove the leading '--')
            const flag = arg.slice(2);

            // Check if there is a corresponding value
            const value = args[i + 1];

            // Add the flag-value pair to the flags object
            flags[flag] = value || true;
        }
    }

    return flags;
}

async function main() {
    // Advance local pools accepts an optional second argument to denote
    // which milestone the local blockchain should be advanced to.
    // The default option will advance to the start of the next epoch.
    // The "endOfGracePeriod" option will advance to the currentEpoch + latePaymentGracePeriod,
    // which is needed to check refreshCredit logic
    const advanceOption = getFlags()["advance-option"] || "nextEpoch";

    let timeToAdvance;
    const PoolConfig = await ethers.getContractFactory("PoolConfig");
    const poolConfigContract = PoolConfig.attach(deploy.poolConfig);
    const poolSettings = await poolConfigContract.getPoolSettings();
    const Calendar = await ethers.getContractFactory("Calendar");
    const calendarContract = Calendar.attach(deploy.calendar);
    const currentBlockTimestamp = await time.latest();

    if (advanceOption == "after-grace") {
        // Advance to the currentEpoch + latePaymentGracePeriod
        // Load latePaymentGracePeriodInDays
        const latePaymentGracePeriodInDays = poolSettings.latePaymentGracePeriodInDays;

        // Get current epoch start time
        const currentEpochStartTime = await calendarContract.getStartDateOfPeriod(
            poolSettings.payPeriodDuration,
            currentBlockTimestamp,
        );

        // Advance chain by currentEpochStartTime + latePaymentGracePeriodInDays * SECONDS_IN_DAY - currentBlockTimestamp
        timeToAdvance =
            currentEpochStartTime.toNumber() +
            latePaymentGracePeriodInDays * SECONDS_IN_DAY -
            currentBlockTimestamp;
    } else {
        // Advance to the next epoch
        // Get current block timestamp
        const currentBlockTimestamp = await time.latest();

        // Get next epoch start time
        const nextEpochStartTime = await calendarContract.getStartDateOfNextPeriod(
            poolSettings.payPeriodDuration,
            currentBlockTimestamp,
        );

        timeToAdvance = nextEpochStartTime.toNumber() - currentBlockTimestamp;
    }

    console.log(
        `Advancing blockchain by ${timeToAdvance} seconds (~${(
            timeToAdvance /
            60 /
            60 /
            24
        ).toPrecision(3)} days)`,
    );

    // Simulate the passage of time by advancing the time on the Hardhat Network
    await network.provider.send("evm_increaseTime", [timeToAdvance]);
    await network.provider.send("evm_mine");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
