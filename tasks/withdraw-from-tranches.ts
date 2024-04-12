import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { getAccountSigners } from "./utils";

async function redeemFromTranche(
    hre: HardhatRuntimeEnvironment,
    trancheVaultContractAddr: string,
    redemptionRequester: SignerWithAddress,
): Promise<void> {
    const TrancheVault = await hre.ethers.getContractFactory("TrancheVault");
    const trancheVaultContract = TrancheVault.attach(trancheVaultContractAddr);
    const disburseTx = await trancheVaultContract
        .connect(redemptionRequester)
        .withdrawAfterPoolClosure();
    await disburseTx.wait();
}

task(
    "withdrawFromTranches",
    "Submit withdrawal and redemption requests and prepare pool for closing",
)
    .addParam(
        "poolConfigAddr",
        "The address of the Pool Config whose epoch you wish to advance to next",
    )
    .setAction(async (taskArgs: { poolConfigAddr: string }, hre: HardhatRuntimeEnvironment) => {
        const { poolOwnerTreasury, evaluationAgent, juniorLender, seniorLender, treasury } =
            await getAccountSigners(hre.ethers);

        const PoolConfig = await hre.ethers.getContractFactory("PoolConfig");
        const poolConfigContract = PoolConfig.attach(taskArgs.poolConfigAddr);

        const poolFeeManagerAddr = await poolConfigContract.poolFeeManager();
        const PoolFeeManager = await hre.ethers.getContractFactory("PoolFeeManager");
        const poolFeeManagerContract = PoolFeeManager.attach(poolFeeManagerAddr);
        const withdrawables = await poolFeeManagerContract.getWithdrawables();
        console.log('Withdrawables: ', withdrawables);
        
        console.log("Withdrawing from pool tranches");
        const juniorTranche = await poolConfigContract.juniorTranche();
        const seniorTranche = await poolConfigContract.seniorTranche();
        
        // Redeem from tranches
        await redeemFromTranche(hre, juniorTranche, juniorLender);
        await redeemFromTranche(hre, juniorTranche, poolOwnerTreasury);
        await redeemFromTranche(hre, juniorTranche, evaluationAgent);
        await redeemFromTranche(hre, seniorTranche, seniorLender);

        // await poolFeeManagerContract.connect(treasury).withdrawProtocolFee(withdrawables.protocolWithdrawable);
    });
