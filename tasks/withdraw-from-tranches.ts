import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";

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
        let juniorLender: SignerWithAddress,
            seniorLender: SignerWithAddress,
            poolOwnerTreasury: SignerWithAddress,
            evaluationAgent: SignerWithAddress;
        [, , , , , , poolOwnerTreasury, evaluationAgent, , juniorLender, seniorLender] =
            await hre.ethers.getSigners();

        const PoolConfig = await hre.ethers.getContractFactory("PoolConfig");
        const poolConfigContract = PoolConfig.attach(taskArgs.poolConfigAddr);

        console.log("Withdrawing from pool tranches");
        const juniorTranche = await poolConfigContract.juniorTranche();
        const seniorTranche = await poolConfigContract.seniorTranche();

        // Redeem from tranches
        await redeemFromTranche(hre, juniorTranche, juniorLender);
        await redeemFromTranche(hre, juniorTranche, poolOwnerTreasury);
        await redeemFromTranche(hre, juniorTranche, evaluationAgent);
        await redeemFromTranche(hre, seniorTranche, seniorLender);
    });
