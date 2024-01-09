import { time } from "@nomicfoundation/hardhat-network-helpers";
import { ethers } from "hardhat";
import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types/runtime";

task("advanceEpoch", "Advances time in the local blockchain based on options")
    .addParam(
        "poolConfigAddr",
        "The address of the Pool Config whose epoch you wish to advance to next",
    )
    .setAction(async (taskArgs: { poolConfigAddr: string }, hre: HardhatRuntimeEnvironment) => {
        console.log("Advancing to next epoch");
        let timeToAdvance;
        const PoolConfig = await ethers.getContractFactory("PoolConfig");
        const poolConfigContract = PoolConfig.attach(taskArgs.poolConfigAddr);
        const poolSettings = await poolConfigContract.getPoolSettings();
        const Calendar = await ethers.getContractFactory("Calendar");
        const calendarAddress = await poolConfigContract.calendar();
        const calendarContract = Calendar.attach(calendarAddress);
        const currentBlockTimestamp = await time.latest();

        // Advance to the next epoch
        // Get next epoch start time
        const nextEpochStartTime = await calendarContract.getStartDateOfNextPeriod(
            poolSettings.payPeriodDuration,
            currentBlockTimestamp,
        );
        timeToAdvance = nextEpochStartTime.toNumber() - currentBlockTimestamp;

        if (timeToAdvance < 0) {
            console.log("The selected milestone is in the past. Exiting.");
            return;
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
