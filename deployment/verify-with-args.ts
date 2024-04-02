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
        ["0x9eA47A502BEffB25c8d559e614203562bb7d886d"],
        ["0xABd48A580F66ad5Ad0Fe983968De686F408c88EE"],
        "0xABd48A580F66ad5Ad0Fe983968De686F408c88EE",
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
    if (chainId != 31337 && process.env.CELOSCAN_API_KEY) {
        await verify("0x14B067bac6039429A11baf564db90eDBcc4E27F3", args);
    }
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
