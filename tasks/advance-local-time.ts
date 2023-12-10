import { time } from "@nomicfoundation/hardhat-network-helpers";
import { task } from "hardhat/config";

const SECONDS_IN_DAY = 24 * 60 * 60;

const localContracts = {
    pool: "0x959922bE3CAee4b8Cd9a407cc3ac1C251C2007B1",
    epochManager: "0x9A9f2CCfdE556A7E9Ff0848998Aa4a0CFD8863AE",
    poolConfig: "0x610178dA211FEF7D417bC0e6FeD39F05609AD788",
    poolCredit: "0x59b670e9fA9D0A427751Af201D676719a970857b",
    juniorTranche: "0x3Aa5ebB10DC797CAC828524e59A333d0A371443c",
    seniorTranche: "0x68B1D87F95878fE05B998F19b66F4baba5De1aed",
    poolSafe: "0xA51c1fc2f0D1a1b8494Ed1FE312d7C3a78Ed91C0",
    testToken: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318",
    borrowerFLC: "0x0DCd1Bf9A1b36cE34237eEaFef220932846BCD82",
    affiliateFLC: "0x9A676e781A523b5d0C0e43731313A708CB607508",
    calendar: "0xc6e7DF5E7b4f2A278906862b61205850344D4e7d",
};

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
        const poolConfigContract = PoolConfig.attach(localContracts.poolConfig);
        const poolSettings = await poolConfigContract.getPoolSettings();
        const Calendar = await hre.ethers.getContractFactory("Calendar");
        const calendarContract = Calendar.attach(localContracts.calendar);
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
