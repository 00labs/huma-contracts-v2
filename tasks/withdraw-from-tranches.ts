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
    const disburseTx = await trancheVaultContract.connect(redemptionRequester).disburse();
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
    .addParam("poolType", "The type of pool this is (e.g. CreditLine, ReceivableBackedCreditLine)")
    .setAction(
        async (
            taskArgs: { poolConfigAddr: string; poolType: string },
            hre: HardhatRuntimeEnvironment,
        ) => {
            let juniorLender: SignerWithAddress,
                seniorLender: SignerWithAddress,
                poolAffiliate: SignerWithAddress,
                borrowerActive: SignerWithAddress;

            [, , , , , , , , , juniorLender, seniorLender, poolAffiliate, , borrowerActive] =
                await hre.ethers.getSigners();

            const PoolConfig = await hre.ethers.getContractFactory("PoolConfig");
            const poolConfigContract = PoolConfig.attach(taskArgs.poolConfigAddr);

            if (taskArgs.poolType === "CreditLine") {
                console.log("Withdrawing from CreditLine pool tranches");
                const juniorTranche = await poolConfigContract.juniorTranche();
                const seniorTranche = await poolConfigContract.seniorTranche();

                // Submit redemption requests
                await redeemFromTranche(hre, juniorTranche, juniorLender);
                await redeemFromTranche(hre, seniorTranche, seniorLender);
            } else if (taskArgs.poolType === "ReceivableBackedCreditLine") {
                // todo fill in this section
            }
        },
    );
