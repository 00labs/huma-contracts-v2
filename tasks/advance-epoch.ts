import { time } from "@nomicfoundation/hardhat-network-helpers";
import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types/runtime";

task("advanceEpoch", "Advances time in the local blockchain based on options")
    .addParam(
        "poolConfigAddr",
        "The address of the Pool Config whose epoch you wish to advance to next",
    )
    .setAction(async (taskArgs: { poolConfigAddr: string }, hre: HardhatRuntimeEnvironment) => {
        console.log("Advancing to next epoch");
        const PoolConfig = await hre.ethers.getContractFactory("PoolConfig");
        const poolConfigContract = PoolConfig.attach(taskArgs.poolConfigAddr);
        const poolSettings = await poolConfigContract.getPoolSettings();
        const Calendar = await hre.ethers.getContractFactory("Calendar");
        const calendarAddress = await poolConfigContract.calendar();
        const calendarContract = Calendar.attach(calendarAddress);
        const currentBlockTimestamp = await time.latest();

        // Advance to the next epoch
        // Get next epoch start time
        const nextEpochStartTime = await calendarContract.getStartDateOfNextPeriod(
            poolSettings.payPeriodDuration,
            currentBlockTimestamp,
        );
        const timestampToAdvance = nextEpochStartTime.toNumber() - currentBlockTimestamp;

        if (timestampToAdvance < currentBlockTimestamp) {
            console.log("The selected milestone is in the past. Exiting.");
            return;
        }

        console.log(`Advancing blockchain to ${timestampToAdvance}`);

        // Simulate the passage of time by advancing the time on the Hardhat Network
        await hre.network.provider.send("evm_setNextBlockTimestamp", [timestampToAdvance]);
        await hre.network.provider.send("evm_mine");
    });
