import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { CONSTANTS } from "../test/constants";
import { FirstLossCover } from "../typechain-types";
import { getAccountSigners } from "./utils";

async function withdrawFromFLC(
    flcContract: FirstLossCover,
    redemptionRequester: SignerWithAddress,
): Promise<void> {
    const redemptionShares = await flcContract.balanceOf(redemptionRequester.address);
    if (redemptionShares.gt(0)) {
        const redeemCoverTx = await flcContract
            .connect(redemptionRequester)
            .redeemCover(redemptionShares, redemptionRequester.address);
        await redeemCoverTx.wait();
    }
}

task(
    "withdrawFLCAndClosePool",
    "Submit withdrawal and redemption requests and prepare pool for closing",
)
    .addParam(
        "poolConfigAddr",
        "The address of the Pool Config whose epoch you wish to advance to next",
    )
    .setAction(async (taskArgs: { poolConfigAddr: string }, hre: HardhatRuntimeEnvironment) => {
        console.log("Preparing pool for closing");
        const {
            treasury,
            poolOwner,
            poolOwnerTreasury,
            evaluationAgent,
            borrowerActive,
        } = await getAccountSigners(hre.ethers);

        const PoolConfig = await hre.ethers.getContractFactory("PoolConfig");
        const poolConfigContract = PoolConfig.attach(taskArgs.poolConfigAddr);
        const FirstLossCover = await hre.ethers.getContractFactory("FirstLossCover");
        const flcContracts = await poolConfigContract.getFirstLossCovers();
        const borrowerFirstLossCoverContract = FirstLossCover.attach(
            flcContracts[CONSTANTS.BORROWER_LOSS_COVER_INDEX],
            );
        const affiliateFirstLossCoverContract = FirstLossCover.attach(
            flcContracts[CONSTANTS.ADMIN_LOSS_COVER_INDEX],
        );
        
        await poolConfigContract.connect(poolOwner).setPoolOwnerRewardsAndLiquidity(0, 0);
        await poolConfigContract.connect(poolOwner).setEARewardsAndLiquidity(0, 0);
                
        console.log("Closing pool");
        const Pool = await hre.ethers.getContractFactory("Pool");
        const poolContract = Pool.attach(await poolConfigContract.pool());
        await poolContract.connect(poolOwner).closePool();

        await console.log("Withdrawing from FLC");
        await withdrawFromFLC(borrowerFirstLossCoverContract, borrowerActive);
        await withdrawFromFLC(affiliateFirstLossCoverContract, evaluationAgent);
        await withdrawFromFLC(affiliateFirstLossCoverContract, treasury);
        await withdrawFromFLC(affiliateFirstLossCoverContract, poolOwnerTreasury);
    });
