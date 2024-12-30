/* eslint-disable no-undef */
import hre, { ethers, network } from "hardhat";
import { getDeployedContracts, sendTransaction } from "../deployUtils";

let deployer;
let networkName;
let deployedContracts;

async function main() {
    // const networkName = (await hre.ethers.provider.getNetworkName()).name;
    networkName = network.name;
    console.log("networkName : ", networkName);
    const accounts = await hre.ethers.getSigners();
    if (accounts.length == 0) {
        throw new Error("Accounts not set!");
    }
    [deployer] = await accounts;

    console.log("deployer address: " + deployer.address);

    deployedContracts = await getDeployedContracts(networkName);
    console.log(deployedContracts);

    // await initPoolFactory();
    // await createPool();
    await setPool();
}

async function migrateStorage() {}

async function createPool() {
    const poolFactory = await hre.ethers.getContractAt(
        "PoolFactory",
        deployedContracts["PoolFactory"],
    );
    // console.log(await poolFactory.poolImplAddress());
    await sendTransaction("PoolFactory", poolFactory, "deployPool", [
        "Arf 3 month pool",
        "0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4",
        "0x89B599dCc82c42Ef2f17ae39c44e4F6764003518",
        "fixed",
        "receivablebacked",
    ]);
}

async function setPool() {
    const poolFactory = await hre.ethers.getContractAt(
        "PoolFactory",
        deployedContracts["PoolFactory"],
    );

    console.log(await poolFactory.checkPool(1));

    const poolConfig = await hre.ethers.getContractAt(
        "PoolConfig",
        "0xb7902d0257dE7d470e326B9221f02FfeDB670580",
    );

    console.log(await poolConfig.getLPConfig());

    await sendTransaction("PoolFactory", poolFactory, "setLPConfig", [1, 0, 9, 2750, 0, 90, true]);

    // await sendTransaction("PoolFactory", poolFactory, "setPoolSettings", [
    //     1,
    //     5000000000000,
    //     10000000,
    //     0,
    //     15,
    //     60,
    //     10000,
    //     true,
    //     true,
    // ]);

    // await sendTransaction(
    //     "PoolFactory",
    //     poolFactory,
    //     "setFees",
    //     [1, 0, 0, 1100, 0, 100, 0, 0, 0, 0],
    // );

    // await sendTransaction("PoolFactory", poolFactory, "addPoolOperator", [
    //     1,
    //     "0xFE8364850C10141E64B8cb50bEb370B511DEC95f",
    // ]);

    // await sendTransaction("PoolFactory", poolFactory, "setPoolEvaluationAgent", [
    //     1,
    //     "0x1d0952dbe8351477125a31da857e8b148f04372d",
    // ]);

    // await sendTransaction("PoolFactory", poolFactory, "setPoolOwnerTreasury", [
    //     1,
    //     "0x73285f0013f76366e0442180c5ae3a67da2ab4fc",
    // ]);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

async () => {
    const network = (await hre.ethers.provider.getNetwork()).name;
    console.log("network : ", network);
    const [deployer] = await accounts;
    console.log("deployer address: " + deployer);

    const pool = await hre.ethers.getContractAt(
        "Pool",
        "0x5227254a6aCa397e95F310b52f6D3143A5A9Ee14",
    );
    const creditAddr = await pool.credit();
    console.log(`Credit addr ${creditAddr}`);

    // const humaOwner = "0xf52130518d74d14573A59d10a26f6b89A263214e";
    // const newAccounts = [humaOwner];
    // const ethAmount = BN.from("1000000000000000000000");
    // for (const account of newAccounts) {
    //     await hre.network.provider.request({
    //         method: "hardhat_impersonateAccount",
    //         params: [account],
    //     });
    //     await hre.network.provider.send("hardhat_setBalance", [account, ethAmount.toHexString()]);
    // }
    // const FixedSeniorYieldTranchesPolicy = await ethers.getContractFactory("FixedSeniorYieldTranchesPolicy");
    // const fixedSeniorYieldTranchesPolicyContract = await FixedSeniorYieldTranchesPolicy.deploy();
    // await fixedSeniorYieldTranchesPolicyContract.deployed();
    //
    // await fixedSeniorYieldTranchesPolicyContract.copyStorageDataFromOldContract();
    // const tracker = await fixedSeniorYieldTranchesPolicyContract.seniorYieldTracker();
    // console.log(`Yield tracker ${tracker.totalAssets} ${tracker.unpaidYield} ${tracker.lastUpdatedDate}`);

    // const EpochManager = await ethers.getContractFactory("EpochManager");
    // const epochManagerContract = await EpochManager.deploy();
    // await epochManagerContract.deployed();
    // await epochManagerContract.copyStorageDataFromOldContract();
    // const currentEpoch = await epochManagerContract.currentEpoch();
    // console.log(`Current epoch ${currentEpoch.id} ${currentEpoch.endTime}`);
    //
    // const Pool = await ethers.getContractFactory("Pool");
    // const poolContract = await Pool.deploy();
    // await poolContract.deployed();
    // await poolContract.copyStorageDataFromOldContract();
    // const tranchesAssets = await poolContract.tranchesAssets();
    // console.log(`Tranches assets ${tranchesAssets.seniorTotalAssets} ${tranchesAssets.juniorTotalAssets}. Pool status on? ${await pool.isPoolOn()}`);

    // const CreditLine = await ethers.getContractFactory("ReceivableBackedCreditLine");
    // const creditLineContract = await CreditLine.deploy();
    // await creditLineContract.deployed();
    // await creditLineContract.copyStorageDataFromOldContract(borrowerAddress);
    // const creditRecord = await creditLineContract.getCreditRecord(creditHash);
    // console.log(`Credit record ${creditRecord}`);
    // const dueDetail = await creditLineContract.getDueDetail(creditHash);
    // console.log(`Due detail ${dueDetail}`);
    //
    const CreditLineManager = await ethers.getContractFactory("ReceivableBackedCreditLineManager");
    const creditLineManagerContract = await CreditLineManager.deploy();
    await creditLineManagerContract.deployed();
    const receivableIds = Array.from({ length: 32 }, (_, i) => i + 1);
    console.log(`Receivable IDs ${receivableIds}`);
    const borrowerAddress = "0x08534d9b632a7A35d7af4aAe5d487A15FC247691";
    await creditLineManagerContract.copyStorageDataFromOldContract(borrowerAddress, receivableIds);
    const creditHash = await creditLineManagerContract.getCreditHash(borrowerAddress);
    const creditConfig = await creditLineManagerContract.getCreditConfig(creditHash);
    console.log(`Credit config ${creditConfig}`);
    const creditBorrower = await creditLineManagerContract.getCreditBorrower(creditHash);
    console.log(`Credit borrower ${creditBorrower}`);
    const availableCredits = await creditLineManagerContract.getAvailableCredit(creditHash);
    console.log(`Available credits  ${availableCredits}`);
    for (const i of receivableIds) {
        const receivableBorrower = await creditLineManagerContract.receivableBorrowerMap(i);
        console.log(`Receivable borrower ${receivableBorrower}`);
    }

    // const TrancheVault = await ethers.getContractFactory("TrancheVault");
    // const trancheVaultContract = await TrancheVault.deploy();
    // await trancheVaultContract.deployed();
    //
    // const lenderAddrs = [
    //     "0x0093ca32a2e51c0ef80f0a2c5e61472e9475f2eb",
    //     "0x00a6ebf6b830cf0e5e3cecb238f09f9aa77349a5",
    //     "0x00c5994aa58211878055091c936e660071a1b14e",
    //     "0x00eef0e5b85b7980971b029d22b53f3de468f361",
    //     "0x01238ba1b264777c87bc8e0d1da19e923a5e178e",
    //     "0x01667c428f74e195f2819a986384af3d98d72c87",
    //     "0x01aa7d309fb1f6f15d9044a5558f497d2c5b54c1",
    //     "0x0206171cdd913fc2df3d1b084291f424ef680d94",
    //     "0x021caaacb555194157da6b3c3ed81662f45b1e47",
    //     "0x022426719795f82a15bb850df9ee90796ba4ef5e",
    //     "0x027b9117b4d22d23e5656d0925ea7a8ad8759da0",
    //     "0x02caaa46b77ae1fd7246cd6bda0e41c67398fecd",
    //     "0x0333f6c7b94c154f8c3d8f89cc34523103aab704",
    //     "0x03894d4ac41dd6c4c2f524ed4417c90fa46972c6",
    //     "0x03edd76c30398a47b61857138d1197cad32db02f",
    //     "0x0478a131ea1d8cd5aec15242ea91f37a91f9c879",
    //     "0x048d703a1e9c69eb09b1919fc0a0217c0c0e5ec5",
    //     "0x04fcf80ec93bb60663aecfcb9895e50b61d79357",
    //     "0x059333e75d0d77403d64eb58eb8eb52722235caa",
    //     "0x05c4e703367f07975b7221d3b62fee59b4436d13",
    //     "0x05cd4623c48553a3070061f557bc38a1d00f716c",
    //     "0x066e5f54593de71fd01f3aa30214f1622c1bf7b0",
    //     "0x06b2d84b6ac9d5fe319a77b9132d34b30276e6c5",
    //     "0x06e294e265d7cf11e1be57be7c7c130185376297",
    //     "0x0737aa1bab327a1f596561661d94c74b40b91892",
    //     "0x0743542070891051861f8d0a4550f97b43b0b89a",
    //     "0x075d3bbcccd1b5f1a42a143a97180a0224a8439c",
    //     "0x08d7bbab0eb5455709b74fa6c874331fdf97b7b2",
    //     "0x0acec13c133e7164378995c6fd3f133aa2331e83",
    //     "0x0c42df09bca99343df6a32f66a7eefd457e54e7e",
    //     "0x0c531b822efaa7bed5044cfed96b8d45f8e5d33d",
    //     "0x0d3bb6eb10fd8109a1bc5aba78f9841c609f9a11",
    //     "0x0d4927ab3430ceae2d8d4c530d4a1af395060aa0",
    //     "0x0dde3ec88d6343d01e8290ec09021bfdeb4ea91e",
    //     "0x0df420969fb8bcb4e1f6b7529fb097278d426b45",
    //     "0x0e4e36d0d3a408418733f2992540ce0fd30952ac",
    //     "0x0ed06731e47143923ce0388c9ce95db0d910a078",
    //     "0x0f37f7685c5e32463f9d96eb28117ca34bf1005f",
    //     "0x0fd6e270cca695a12e99731a9cc9cc34c7d66a63",
    //     "0x0ff2c13c0bca5784d15d3c4553ad11edd289e368",
    //     "0x10115ea72868edacc4fda8f398043ca593f5b830",
    //     "0x10408ad1ab8a3ecef36c16e56305d24c60559ac4",
    //     "0x10eb74e3bf7aa53c4ce96468a318e5813dcb9a9b",
    //     "0x1118003aeb105955eac012884cb07b36e76e0181",
    //     "0x11315cce8f009e4cb4234ffeaf2e860b84e5b0f6",
    //     "0x11ba82668211e7fadcbc126e2c798b18b78084e4",
    //     "0x11bada5283a9a589b059285a8ec7fb538b077b5a",
    //     "0x11bf6cadea898415c515608b58d337941faab6ac",
    //     "0x11e223c49b3bc43c011ef62f79ce81bfd29d3b74",
    //     "0x124b3811b3db2e368441eceeb81c9938028d82cd",
    // ]
    // await trancheVaultContract.copyStorageDataFromOldContract("0x483D02C11f8F1E31C267040A6C86AaB80c428BaB", lenderAddrs, [6, 7]);
    //
    // const oldTrancheVault = await hre.ethers.getContractAt("TrancheVault", "0x483D02C11f8F1E31C267040A6C86AaB80c428BaB");
    // for (const epochId of [6, 7]) {
    //     const oldSummary = await oldTrancheVault.epochRedemptionSummary(epochId);
    //     const newSummary = await trancheVaultContract.epochRedemptionSummary(epochId);
    //     expect(oldSummary.epochId).to.eq(newSummary.epochId);
    //     expect(oldSummary.totalSharesRequested).to.eq(newSummary.totalSharesRequested);
    //     expect(oldSummary.totalSharesProcessed).to.eq(newSummary.totalSharesProcessed);
    //     expect(oldSummary.totalAmountProcessed).to.eq(newSummary.totalAmountProcessed);
    // }
    //
    // for (const lender of lenderAddrs) {
    //     const oldRedemptionRecord = await oldTrancheVault.lenderRedemptionRecords(lender);
    //     const newRedemptionRecord = await trancheVaultContract.lenderRedemptionRecords(lender);
    //     expect(oldRedemptionRecord.nextEpochIdToProcess).to.eq(newRedemptionRecord.nextEpochIdToProcess);
    //     expect(oldRedemptionRecord.numSharesRequested).to.eq(newRedemptionRecord.numSharesRequested);
    //     expect(oldRedemptionRecord.principalRequested).to.eq(newRedemptionRecord.principalRequested);
    //     expect(oldRedemptionRecord.totalAmountProcessed).to.eq(newRedemptionRecord.totalAmountProcessed);
    //     expect(oldRedemptionRecord.totalAmountWithdrawn).to.eq(newRedemptionRecord.totalAmountWithdrawn);
    //
    //     const oldDepositRecord = await oldTrancheVault.depositRecords(lender);
    //     const newDepositRecord = await trancheVaultContract.depositRecords(lender);
    //     expect(oldDepositRecord.principal).to.eq(newDepositRecord.principal);
    //     expect(oldDepositRecord.reinvestYield).to.eq(newDepositRecord.reinvestYield);
    //     expect(oldDepositRecord.lastDepositTime).to.eq(newDepositRecord.lastDepositTime);
    //
    //     const oldBalance = await oldTrancheVault.balanceOf(lender);
    //     const newBalance = await trancheVaultContract.balanceOf(lender);
    //     expect(oldBalance).to.eq(newBalance);
    // }
    //
    // await trancheVaultContract.restoreLPTokensForTrancheVault("0x483D02C11f8F1E31C267040A6C86AaB80c428BaB");
    // const oldBalance = await oldTrancheVault.balanceOf("0x483D02C11f8F1E31C267040A6C86AaB80c428BaB");
    // const newBalance = await trancheVaultContract.balanceOf(trancheVaultContract.address);
    // expect(oldBalance).to.eq(newBalance);
    // const oldTotalSupply = await oldTrancheVault.totalSupply();
    // const newTotalSupply = await trancheVaultContract.totalSupply();
    // expect(oldTotalSupply).to.eq(newTotalSupply);
    // console.log("Done!")
};
