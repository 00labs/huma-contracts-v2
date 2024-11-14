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

async function withdrawFromTranche(
    hre: HardhatRuntimeEnvironment,
    trancheVaultContractAddr: string,
    redemptionRequester: SignerWithAddress,
): Promise<void> {
    const TrancheVault = await hre.ethers.getContractFactory("TrancheVault");
    const trancheVaultContract = TrancheVault.attach(trancheVaultContractAddr);
    const tx = await trancheVaultContract
        .connect(redemptionRequester)
        .withdrawAfterPoolClosure();
    await tx.wait();
}

task(
    "withdrawAndClosePool",
    "Submit withdrawal and redemption requests and prepare pool for closing",
)
    .addParam(
        "poolConfigAddr",
        "The PoolConfig contract address of the pool in question",
    )
    .setAction(async (taskArgs: { poolConfigAddr: string }, hre: HardhatRuntimeEnvironment) => {
        console.log("Preparing pool for closing");
        const {
            treasury,
            poolOwner,
            poolOwnerTreasury,
            evaluationAgent,
            borrowerActive,
            juniorLender,
            seniorLender
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
                
        console.log("Closing pool");
        const Pool = await hre.ethers.getContractFactory("Pool");
        const poolContract = Pool.attach(await poolConfigContract.pool());
        await poolContract.connect(poolOwner).closePool();

        await console.log("Withdrawing from FLC");
        await withdrawFromFLC(borrowerFirstLossCoverContract, borrowerActive);
        await withdrawFromFLC(affiliateFirstLossCoverContract, evaluationAgent);
        await withdrawFromFLC(affiliateFirstLossCoverContract, treasury);
        await withdrawFromFLC(affiliateFirstLossCoverContract, poolOwnerTreasury);
    
        console.log("Withdrawing from pool tranches");
        const juniorTranche = await poolConfigContract.juniorTranche();
        const seniorTranche = await poolConfigContract.seniorTranche();

        // Debug logs
        // const TrancheVault = await hre.ethers.getContractFactory("TrancheVault");
        // const juniorTrancheContract = TrancheVault.attach(juniorTranche);
        // const seniorTrancheContract = TrancheVault.attach(seniorTranche);
        // console.log(await juniorTrancheContract.withdrawableAssets(juniorLender.address));
        // console.log(await juniorTrancheContract.withdrawableAssets(poolOwnerTreasury.address));
        // console.log(await juniorTrancheContract.withdrawableAssets(evaluationAgent.address));
        // console.log(await juniorTrancheContract.withdrawableAssets(seniorLender.address));
        // console.log(await juniorTrancheContract.withdrawableAssets(treasury.address));
        // console.log(await seniorTrancheContract.withdrawableAssets(juniorLender.address));
        // console.log(await seniorTrancheContract.withdrawableAssets(poolOwnerTreasury.address));
        // console.log(await seniorTrancheContract.withdrawableAssets(evaluationAgent.address));
        // console.log(await seniorTrancheContract.withdrawableAssets(seniorLender.address));
        // console.log(await seniorTrancheContract.withdrawableAssets(treasury.address));
        
        // Redeem from tranches
        await withdrawFromTranche(hre, juniorTranche, juniorLender);
        await withdrawFromTranche(hre, juniorTranche, poolOwnerTreasury);
        await withdrawFromTranche(hre, juniorTranche, evaluationAgent);
        await withdrawFromTranche(hre, seniorTranche, seniorLender);
        await withdrawFromTranche(hre, seniorTranche, poolOwnerTreasury);
    });
