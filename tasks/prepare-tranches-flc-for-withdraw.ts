import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { CONSTANTS } from "../test/constants";
import { FirstLossCover } from "../typechain-types";

async function submitRedemptionRequestToTranche(
    hre: HardhatRuntimeEnvironment,
    trancheVaultContractAddr: string,
    redemptionRequester: SignerWithAddress,
): Promise<void> {
    const TrancheVault = await hre.ethers.getContractFactory("TrancheVault");
    const trancheVaultContract = TrancheVault.attach(trancheVaultContractAddr);
    const redemptionShares = await trancheVaultContract.balanceOf(redemptionRequester.address);
    const redemptionRequest = await trancheVaultContract
        .connect(redemptionRequester)
        .addRedemptionRequest(redemptionShares);
    await redemptionRequest.wait();
}

async function withdrawFromFLC(
    flcContract: FirstLossCover,
    redemptionRequester: SignerWithAddress,
): Promise<void> {
    const redemptionShares = await flcContract.balanceOf(redemptionRequester.address);
    console.log(
        redemptionShares,
        " ",
        redemptionRequester.address,
        " ",
        await flcContract.totalSupply(),
    );
    const redemptionRequest = await flcContract
        .connect(redemptionRequester)
        .redeemCover(redemptionShares, redemptionRequester.address);
    await redemptionRequest.wait();
    const b = await flcContract.balanceOf(redemptionRequester.address);
    console.log(b, " ", redemptionRequester.address, " ", await flcContract.totalSupply());
}

task(
    "prepareTranchesFlcForWithdraw",
    "Submit withdrawal and redemption requests and prepare pool for closing",
)
    .addParam(
        "poolConfigAddr",
        "The address of the Pool Config whose epoch you wish to advance to next",
    )
    .addParam("poolType", "The type of pool this is (e.g. CreditLine, ArfV2)")
    .setAction(async (taskArgs: any, hre: HardhatRuntimeEnvironment) => {
        let poolOwner: SignerWithAddress,
            poolOwnerTreasury: SignerWithAddress,
            evaluationAgent: SignerWithAddress,
            juniorLender: SignerWithAddress,
            seniorLender: SignerWithAddress,
            borrowerActive: SignerWithAddress,
            treasury: SignerWithAddress;

        console.log("Preparing pool for closing");
        [
            ,
            ,
            treasury,
            ,
            ,
            poolOwner,
            poolOwnerTreasury,
            evaluationAgent,
            ,
            juniorLender,
            seniorLender,
            ,
            ,
            borrowerActive,
        ] = await hre.ethers.getSigners();

        const PoolConfig = await hre.ethers.getContractFactory("PoolConfig");
        const poolConfigContract = PoolConfig.attach(taskArgs.poolConfigAddr);

        if (taskArgs.poolType === "CreditLine") {
            console.log("Submitting redemption requests to tranches");
            const juniorTranche = await poolConfigContract.juniorTranche();
            const seniorTranche = await poolConfigContract.seniorTranche();

            await poolConfigContract.connect(poolOwner).setPoolOwnerRewardsAndLiquidity(0, 0);
            await poolConfigContract.connect(poolOwner).setEARewardsAndLiquidity(0, 0);

            // Submit redemption requests
            await submitRedemptionRequestToTranche(hre, juniorTranche, juniorLender);
            await submitRedemptionRequestToTranche(hre, juniorTranche, poolOwnerTreasury);
            await submitRedemptionRequestToTranche(hre, juniorTranche, evaluationAgent);
            await submitRedemptionRequestToTranche(hre, seniorTranche, seniorLender);

            console.log("Setting FLC to ready for withdraw");
            const FirstLossCover = await hre.ethers.getContractFactory("FirstLossCover");
            const flcContracts = await poolConfigContract.getFirstLossCovers();
            const borrowerFirstLossCoverContract = FirstLossCover.attach(
                flcContracts[CONSTANTS.BORROWER_LOSS_COVER_INDEX],
            );
            const affiliateFirstLossCoverContract = FirstLossCover.attach(
                flcContracts[CONSTANTS.ADMIN_LOSS_COVER_INDEX],
            );

            // Set FLC ready to withdraw
            const Pool = await hre.ethers.getContractFactory("Pool");
            const poolContract = Pool.attach(await poolConfigContract.pool());
            await poolContract.connect(poolOwner).setReadyForFirstLossCoverWithdrawal(true);

            await console.log("Withdrawing from FLC");
            await withdrawFromFLC(borrowerFirstLossCoverContract, borrowerActive);
            await withdrawFromFLC(affiliateFirstLossCoverContract, poolOwnerTreasury);
            await withdrawFromFLC(affiliateFirstLossCoverContract, evaluationAgent);
            await withdrawFromFLC(affiliateFirstLossCoverContract, treasury);
        } else if (taskArgs.poolType === "ArfV2") {
            // todo fill in this section
        }
    });
