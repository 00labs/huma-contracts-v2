import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";
import {
    BorrowerLevelCreditManager,
    Calendar,
    CreditDueManager,
    EpochManager,
    EvaluationAgentNFT,
    FirstLossCover,
    HumaConfig,
    MockPoolCredit,
    MockToken,
    Pool,
    PoolConfig,
    PoolFeeManager,
    PoolSafe,
    Receivable,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../../../typechain-types";
import { deployAndSetupPoolContracts, deployProtocolContracts } from "../../BaseTest";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    pdsServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOperator: SignerWithAddress,
    lender: SignerWithAddress;

let eaNFTContract: EvaluationAgentNFT,
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken;
let poolConfigContract: PoolConfig,
    poolFeeManagerContract: PoolFeeManager,
    poolSafeContract: PoolSafe,
    calendarContract: Calendar,
    borrowerFirstLossCoverContract: FirstLossCover,
    affiliateFirstLossCoverContract: FirstLossCover,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: MockPoolCredit,
    creditDueManagerContract: CreditDueManager,
    creditManagerContract: BorrowerLevelCreditManager,
    receivableContract: Receivable;

describe("Upgradeability Test", function () {
    before(async function () {
        [
            defaultDeployer,
            protocolOwner,
            treasury,
            eaServiceAccount,
            pdsServiceAccount,
            poolOwner,
            poolOwnerTreasury,
            evaluationAgent,
            poolOperator,
            lender,
        ] = await ethers.getSigners();
    });

    async function prepare() {
        [eaNFTContract, humaConfigContract, mockTokenContract] = await deployProtocolContracts(
            protocolOwner,
            treasury,
            eaServiceAccount,
            pdsServiceAccount,
            poolOwner,
        );

        [
            poolConfigContract,
            poolFeeManagerContract,
            poolSafeContract,
            calendarContract,
            borrowerFirstLossCoverContract,
            affiliateFirstLossCoverContract,
            tranchesPolicyContract,
            poolContract,
            epochManagerContract,
            seniorTrancheVaultContract,
            juniorTrancheVaultContract,
            creditContract as unknown,
            creditDueManagerContract,
            creditManagerContract as unknown,
            receivableContract,
        ] = await deployAndSetupPoolContracts(
            humaConfigContract,
            mockTokenContract,
            eaNFTContract,
            "RiskAdjustedTranchesPolicy",
            defaultDeployer,
            poolOwner,
            "MockPoolCredit",
            "BorrowerLevelCreditManager",
            evaluationAgent,
            poolOwnerTreasury,
            poolOperator,
            [lender],
        );
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    // A test that checks upgradeability of the PoolConfig contract
    it("PoolConfig upgrade test", async function () {
        const PoolConfig = await ethers.getContractFactory("PoolConfig");
        const poolConfigNewImpl = await PoolConfig.deploy();
        await poolConfigNewImpl.deployed();
        await expect(
            poolConfigContract.connect(protocolOwner).upgradeTo(poolConfigNewImpl.address),
        )
            .to.emit(poolConfigContract, "Upgraded")
            .withArgs(poolConfigNewImpl.address);
    });

    //Account other than protocol owner tries to upgrade PoolConfig contract
    it("PoolConfig upgrade test - non protocol owner", async function () {
        const PoolConfig = await ethers.getContractFactory("PoolConfig");
        const poolConfigNewImpl = await PoolConfig.deploy();
        await poolConfigNewImpl.deployed();
        await expect(
            poolConfigContract.connect(poolOwner).upgradeTo(poolConfigNewImpl.address),
        ).to.be.revertedWithCustomError(poolConfigContract, "AdminRequired");
    });

    // A test that checks upgradeability of a Pool contract
    it("PoolConfigCache upgrade test", async function () {
        const Pool = await ethers.getContractFactory("Pool");
        const poolNewImpl = await Pool.deploy();
        await poolNewImpl.deployed();
        await expect(poolContract.connect(protocolOwner).upgradeTo(poolNewImpl.address))
            .to.emit(poolContract, "Upgraded")
            .withArgs(poolNewImpl.address);
    });

    //Account other than protocol owner tries to upgrade Pool contract
    it("PoolConfigCache upgrade test - non protocol owner", async function () {
        const Pool = await ethers.getContractFactory("Pool");
        const poolNewImpl = await Pool.deploy();
        await poolNewImpl.deployed();
        await expect(
            poolContract.connect(poolOwner).upgradeTo(poolNewImpl.address),
        ).to.be.revertedWithCustomError(poolConfigContract, "AdminRequired");
    });

    // A test that checks upgradeability of the TranchedVault contract
    it("TrancheVault upgrade test", async function () {
        const TrancheVault = await ethers.getContractFactory("TrancheVault");
        const trancheVaultNewImpl = await TrancheVault.deploy();
        await trancheVaultNewImpl.deployed();
        await expect(
            seniorTrancheVaultContract
                .connect(protocolOwner)
                .upgradeTo(trancheVaultNewImpl.address),
        )
            .to.emit(seniorTrancheVaultContract, "Upgraded")
            .withArgs(trancheVaultNewImpl.address);
    });

    //Account other than protocol owner tries to upgrade TranchedVault contract
    it("TrancheVault upgrade test - non protocol owner", async function () {
        const TrancheVault = await ethers.getContractFactory("TrancheVault");
        const trancheVaultNewImpl = await TrancheVault.deploy();
        await trancheVaultNewImpl.deployed();
        await expect(
            seniorTrancheVaultContract.connect(poolOwner).upgradeTo(trancheVaultNewImpl.address),
        ).to.be.revertedWithCustomError(poolConfigContract, "AdminRequired");
    });

    // A test that checks upgradeability of the Receivable contract
    it("Receivable upgrade test", async function () {
        const Receivable = await ethers.getContractFactory("Receivable");
        const receivableNewImpl = await Receivable.deploy();
        await receivableNewImpl.deployed();
        await expect(receivableContract.connect(poolOwner).upgradeTo(receivableNewImpl.address))
            .to.emit(receivableContract, "Upgraded")
            .withArgs(receivableNewImpl.address);
    });

    //Account other than pool owner tries to upgrade Receivable contract
    it("Receivable upgrade test - non pool owner", async function () {
        const Receivable = await ethers.getContractFactory("Receivable");
        const receivableNewImpl = await Receivable.deploy();
        await receivableNewImpl.deployed();
        await expect(
            receivableContract.connect(protocolOwner).upgradeTo(receivableNewImpl.address),
        ).to.be.revertedWith(/AccessControl: account .* is missing role .*/);
    });
});
