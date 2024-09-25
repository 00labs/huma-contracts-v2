import { createObjectCsvWriter } from "csv-writer";
import hre, { network } from "hardhat";
import { getDeployedContracts } from "./deployUtils.ts";

let networkName;
let deployedContracts;

async function saveToCSV(data: object[], path: string) {
    // ...

    // Convert object data to CSV
    const csvWriter = createObjectCsvWriter({
        path: path,
        header: Object.keys(data[0]).map((key) => ({ id: key, title: key })),
    });

    await csvWriter.writeRecords(data);
}

async function queryPoolContractAddresses(poolRecord: object) {
    const contractNames = [
        "juniorTranche",
        "poolSafe",
        "seniorTranche",
        "creditManager",
        "credit",
    ];
    const PoolConfig = await hre.ethers.getContractFactory("PoolConfig");
    const poolConfig = PoolConfig.attach(poolRecord["poolConfigAddress"]);
    let data: object[] = [];
    data.push({
        network: networkName,
        poolId: poolRecord["poolId"],
        contractName: "poolConfig",
        contractAddress: poolRecord["poolConfigAddress"],
    });
    let contractName;
    for (contractName of contractNames) {
        const contractAddress = await poolConfig[contractName]();
        data.push({
            network: networkName,
            poolId: poolRecord["poolId"],
            contractName: contractName,
            contractAddress: contractAddress,
        });
    }
    return data;
}

async function queryPool(poolId: number, poolFactory: any) {
    const data = await poolFactory.checkPool(poolId);
    console.log(data);
    return {
        network: networkName,
        poolId: data.poolId,
        poolName: data.poolName,
        poolStatus: data.poolStatus,
        poolAddress: data.poolAddress,
        poolTimelock: data.poolTimelock,
        poolConfigAddress: data.poolConfigAddress,
    };
}

async function queryPoolFactory() {
    if (!deployedContracts["PoolFactory"]) {
        throw new Error("PoolFactory not deployed yet!");
    }

    const PoolFactory = await hre.ethers.getContractFactory("PoolFactory", {
        libraries: { LibTimelockController: deployedContracts["LibTimelockController"] },
    });
    const poolFactory = PoolFactory.attach(deployedContracts["PoolFactory"]);
    const poolCounter = await poolFactory.poolId();

    let poolData: object[] = [];
    let contractAddresses: object[] = [];
    for (let i = 1; i <= poolCounter; i++) {
        console.log("Checking pool: ", i);
        const data = await queryPool(i, poolFactory);
        console.log("data : ", data);
        contractAddresses.push(...(await queryPoolContractAddresses(data)));
        delete data.poolConfigAddress;
        poolData.push(data);
    }
    await saveToCSV(poolData, `./deployment/${networkName}-pools.csv`);
    await saveToCSV(contractAddresses, `./deployment/${networkName}-pool-contracts.csv`);

    var csvString = poolData
        .map(function (d) {
            return JSON.stringify(Object.values(d));
        })
        .join("\n")
        .replace(/(^\[)|(\]$)/gm, "");
    console.log(csvString);
}

async function listContracts() {
    // const networkName = (await hre.ethers.provider.getNetworkName()).name;
    networkName = network.name;
    console.log("networkName : ", networkName);

    deployedContracts = await getDeployedContracts(networkName);
    // console.log(deployedContracts);
    await queryPoolFactory();
}

listContracts()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
