// TypeScript
import { network, run } from "hardhat";
import { getDeployedContracts } from "./deployUtils";
async function verifyContract(): Promise<void> {
    const chainId = network.config.chainId!;
    console.log(`ChainId: ${chainId}`);

    const chainName = network.name;
    console.log(`ChainName: ${chainName}`);
    const deployedContracts = await getDeployedContracts(chainName);

    const args: unknown[] = [
        0,
        ["0xEC5c04192A251f6ffD42a48ad3Ee8250F7757D08"],
        ["0xEC5c04192A251f6ffD42a48ad3Ee8250F7757D08"],
        "0x0000000000000000000000000000000000000000",
    ];
    // const PoolFactory = await hre.ethers.getContractFactory("PoolFactory", {
    //     libraries: { LibTimelockController: deployedContracts["LibTimelockController"] },
    // });
    // const poolFactoryImpl = PoolFactory.attach(deployedContracts["PoolFactoryImpl"]);
    // const fragment = await poolFactoryImpl.interface.getFunction("initialize(address)");
    // const calldata = await poolFactoryImpl.interface.encodeFunctionData(fragment, [
    //     deployedContracts["HumaConfig"],
    // ]);
    // const args: unknown[] = ["0x077b618a91129435f5110915080c60eea078639f", calldata];

    // * only verify on testnets or mainnets.
    // if (chainId != 31337 && process.env.CELOSCAN_API_KEY) {
    await verify("0xaFD64e8CBE22e2Bd81c3210B2b7AAa43309e7dc5", args);
    // }
}

const verify = async (contractAddress: string, args: unknown[]) => {
    console.log("Verifying contract...");
    try {
        await run("verify:verify", {
            address: contractAddress,
            constructorArguments: args,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
        if (e.message.toLowerCase().includes("already verified")) {
            console.log("Already verified!");
        } else {
            console.log(e);
        }
    }
};

verifyContract()
    .then(() => process.exit(0))
    .catch((error) => {
        console.log(error);
        process.exit(1);
    });
