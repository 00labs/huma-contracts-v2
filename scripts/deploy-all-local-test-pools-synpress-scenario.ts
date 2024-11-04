import { ethers } from "hardhat";
import moment from "moment";
import { getAccountSigners } from "../tasks/utils";
import { toToken } from "../test/TestUtils";
import { deployPools } from "./deploy-local-test-pools";
import { LOCAL_PROVIDER, advanceChainBySeconds, advanceChainToTime } from "./utils";

(async () => {
    try {
        const { poolOwner, juniorLender, sentinelServiceAccount, borrowerInactive } =
            await getAccountSigners(ethers);

        const contracts = await deployPools();

        const creditContracts = contracts[0];
        const lpConfig = await creditContracts.poolConfigContract.getLPConfig();

        // Allow for withdrawals immediately
        await creditContracts.poolConfigContract
            .connect(poolOwner)
            .setLPConfig({ ...lpConfig, ...{ withdrawalLockoutPeriodInDays: 1 } });

        // Advance time to allow for withdrawals
        await advanceChainBySeconds(24 * 60 * 60 + 60);

        // Create redemption request
        await creditContracts.juniorTrancheVaultContract
            .connect(juniorLender)
            .addRedemptionRequest(toToken(10));

        // Advance time to next epoch
        let block = await LOCAL_PROVIDER.getBlock("latest");
        await advanceChainToTime(
            moment.unix(block.timestamp).utc().add(1, "month").startOf("month"),
        );

        // Process redemption requests by closing epoch
        await creditContracts.juniorTrancheVaultContract
            .connect(sentinelServiceAccount)
            .processYieldForLenders();
        await creditContracts.seniorTrancheVaultContract
            .connect(sentinelServiceAccount)
            .processYieldForLenders();
        await creditContracts.epochManagerContract.connect(sentinelServiceAccount).closeEpoch();

        // Revoking allowance for inactive borrower
        await creditContracts.mockTokenContract
            .connect(borrowerInactive)
            .approve(creditContracts.creditContract.address, 0);
        await creditContracts.mockTokenContract
            .connect(borrowerInactive)
            .approve(creditContracts.poolSafeContract.address, 0);

        console.log(
            "Pools are deployed. Junior lender is ready to withdraw from the credit line pool",
        );
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    }
})();
