import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { getAccountSigners } from "./utils";

task(
    "logIncomes",
    "Submit withdrawal and redemption requests and prepare pool for closing",
)
    .addParam(
        "poolConfigAddr",
        "The PoolConfig contract address of the pool in question",
    )
    .setAction(async (taskArgs: { poolConfigAddr: string }, hre: HardhatRuntimeEnvironment) => {
        const { poolOwnerTreasury, evaluationAgent, juniorLender, seniorLender, treasury } =
            await getAccountSigners(hre.ethers);

        const PoolConfig = await hre.ethers.getContractFactory("PoolConfig");
        const poolConfigContract = PoolConfig.attach(taskArgs.poolConfigAddr);

        const poolFeeManagerAddr = await poolConfigContract.poolFeeManager();
        const PoolFeeManager = await hre.ethers.getContractFactory("PoolFeeManager");
        const poolFeeManagerContract = PoolFeeManager.attach(poolFeeManagerAddr);

        console.log('Accrued Incomes', await poolFeeManagerContract.getAccruedIncomes());
        console.log('protocolIncomeWithdrawn', await poolFeeManagerContract.protocolIncomeWithdrawn());
        console.log('poolOwnerIncomeWithdrawn', await poolFeeManagerContract.poolOwnerIncomeWithdrawn());
        console.log('eaIncomeWithdrawn', await poolFeeManagerContract.eaIncomeWithdrawn());
    });
