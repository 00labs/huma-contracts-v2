import { time } from "@nomicfoundation/hardhat-network-helpers";
import { task } from "hardhat/config";

const localContracts = {
    poolConfig: "0x610178dA211FEF7D417bC0e6FeD39F05609AD788",
    calendar: "0xc6e7DF5E7b4f2A278906862b61205850344D4e7d",
};

task("advance-local-time", "Advances time in the local blockchain based on options").setAction(
    async (_, hre) => {
        console.log("Advancing to next epoch");
        let timeToAdvance;
        const PoolConfig = await hre.ethers.getContractFactory("PoolConfig");
        const poolConfigContract = PoolConfig.attach(localContracts.poolConfig);
        const poolSettings = await poolConfigContract.getPoolSettings();
        const Calendar = await hre.ethers.getContractFactory("Calendar");
        const calendarContract = Calendar.attach(localContracts.calendar);
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
    },
);
