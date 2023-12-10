import { time } from "@nomicfoundation/hardhat-network-helpers";
import { task } from "hardhat/config";
import deploy from "../scripts/local-deploy-const";

const SECONDS_IN_DAY = 24 * 60 * 60;

task("advance-local-time", "Advances the locally deployed pool based on options")
    .addOptionalParam(
        "advanceOption",
        "Option to denote the milestone for advancing the local blockchain (nextEpoch for the next epoch start time or after-grace for after the next grace period)",
        "nextEpoch",
    )
    .setAction(async (taskArgs, hre) => {
        const { advanceOption } = taskArgs;
        console.log(taskArgs);

        let timeToAdvance;
        const PoolConfig = await hre.ethers.getContractFactory("PoolConfig");
        const poolConfigContract = PoolConfig.attach(deploy.poolConfig);
        const poolSettings = await poolConfigContract.getPoolSettings();
        const Calendar = await hre.ethers.getContractFactory("Calendar");
        const calendarContract = Calendar.attach(deploy.calendar);
        const currentBlockTimestamp = await time.latest();

        if (advanceOption.includes("after-grace")) {
            console.log("Advancing to after grace period");
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
            console.log("Advancing to next epoch");
            // Advance to the next epoch
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
        await hre.network.provider.send("evm_increaseTime", [timeToAdvance]);
        await hre.network.provider.send("evm_mine");
    });
