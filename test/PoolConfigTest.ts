import { ethers } from "hardhat";

import { expect } from "chai";
import { deployProtocolContracts } from "./BaseTest";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
    BaseCreditFeeManager,
    BasePnLManager,
    Calendar,
    EpochManager,
    EvaluationAgentNFT,
    HumaConfig,
    FirstLossCover,
    MockPoolCredit,
    MockToken,
    PlatformFeeManager,
    Pool,
    PoolConfig,
    PoolVault,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../typechain-types";

let defaultDeployer: HardhatEthersSigner,
    protocolOwner: HardhatEthersSigner,
    treasury: HardhatEthersSigner,
    eaServiceAccount: HardhatEthersSigner,
    pdsServiceAccount: HardhatEthersSigner;
let poolOwner: HardhatEthersSigner,
    poolOwnerTreasury: HardhatEthersSigner,
    evaluationAgent: HardhatEthersSigner,
    poolOperator: HardhatEthersSigner,
    protocolTreasury: HardhatEthersSigner,
    regularUser: HardhatEthersSigner;

let eaNFTContract: EvaluationAgentNFT,
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken;
let poolConfigContract: PoolConfig,
    platformFeeManagerContract: PlatformFeeManager,
    poolVaultContract: PoolVault,
    calendarContract: Calendar,
    poolOwnerAndEAFirstLossCoverContract: FirstLossCover,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: MockPoolCredit,
    creditFeeManagerContract: BaseCreditFeeManager,
    creditPnlManagerContract: BasePnLManager;

describe("PoolConfig Test", function () {
    async function deployPoolConfigContract() {
        [
            protocolOwner,
            protocolTreasury,
            eaServiceAccount,
            pdsServiceAccount,
            poolOwner,
            regularUser,
        ] = await ethers.getSigners();

        [, humaConfigContract, mockTokenContract] = await deployProtocolContracts(
            protocolOwner,
            protocolTreasury,
            eaServiceAccount,
            pdsServiceAccount,
            poolOwner,
        );
        const PoolConfig = await ethers.getContractFactory("PoolConfig");
        poolConfigContract = await PoolConfig.deploy();
        await poolConfigContract.waitForDeployment();
        await poolConfigContract.grantRole(
            await poolConfigContract.DEFAULT_ADMIN_ROLE(),
            poolOwner.getAddress(),
        );

        const PlatformFeeManager = await ethers.getContractFactory("PlatformFeeManager");
        platformFeeManagerContract = await PlatformFeeManager.deploy();
        await platformFeeManagerContract.waitForDeployment();

        const PoolVault = await ethers.getContractFactory("PoolVault");
        poolVaultContract = await PoolVault.deploy();
        await poolVaultContract.waitForDeployment();

        const FirstLossCover = await ethers.getContractFactory("FirstLossCover");
        poolOwnerAndEAFirstLossCoverContract = await FirstLossCover.deploy();
        await poolOwnerAndEAFirstLossCoverContract.waitForDeployment();

        const TranchesPolicy = await ethers.getContractFactory("RiskAdjustedTranchesPolicy");
        tranchesPolicyContract = await TranchesPolicy.deploy();
        await tranchesPolicyContract.waitForDeployment();

        const Pool = await ethers.getContractFactory("Pool");
        poolContract = await Pool.deploy();
        await poolContract.waitForDeployment();

        const EpochManager = await ethers.getContractFactory("EpochManager");
        epochManagerContract = await EpochManager.deploy();
        await epochManagerContract.waitForDeployment();

        const TrancheVault = await ethers.getContractFactory("TrancheVault");
        seniorTrancheVaultContract = await TrancheVault.deploy();
        await seniorTrancheVaultContract.waitForDeployment();
        juniorTrancheVaultContract = await TrancheVault.deploy();
        await juniorTrancheVaultContract.waitForDeployment();

        const Calendar = await ethers.getContractFactory("Calendar");
        calendarContract = await Calendar.deploy();
        await calendarContract.waitForDeployment();

        const Credit = await ethers.getContractFactory("MockPoolCredit");
        creditContract = await Credit.deploy();
        await creditContract.waitForDeployment();

        const BaseCreditFeeManager = await ethers.getContractFactory("BaseCreditFeeManager");
        creditFeeManagerContract = await BaseCreditFeeManager.deploy();
        await creditFeeManagerContract.waitForDeployment();

        const CreditPnLManager = await ethers.getContractFactory("LinearMarkdownPnLManager");
        creditPnlManagerContract = await CreditPnLManager.deploy();
        await creditPnlManagerContract.waitForDeployment();
    }

    beforeEach(async function () {
        await loadFixture(deployPoolConfigContract);
    });

    describe("Pool config initialization", function () {
        it("Should initialize successfully and sets default values", async function () {
            await poolConfigContract
                .connect(poolOwner)
                .initialize("Base Credit Pool", [
                    humaConfigContract.getAddress(),
                    mockTokenContract.getAddress(),
                    platformFeeManagerContract.getAddress(),
                    poolVaultContract.getAddress(),
                    calendarContract.getAddress(),
                    poolOwnerAndEAFirstLossCoverContract.getAddress(),
                    tranchesPolicyContract.getAddress(),
                    poolContract.getAddress(),
                    epochManagerContract.getAddress(),
                    seniorTrancheVaultContract.getAddress(),
                    juniorTrancheVaultContract.getAddress(),
                    creditContract.getAddress(),
                    creditFeeManagerContract.getAddress(),
                    creditPnlManagerContract.getAddress(),
                ]);

            const poolSettings = await poolConfigContract.getPoolSettings();
            expect(poolSettings.calendarUnit).to.equal(1);
            expect(poolSettings.payPeriodInCalendarUnit).to.equal(1);
            expect(poolSettings.advanceRateInBps).to.equal(10000);
            expect(poolSettings.latePaymentGracePeriodInDays).to.equal(5);
            expect(poolSettings.defaultGracePeriodInCalendarUnit).to.equal(3);

            const adminRnR = await poolConfigContract.getAdminRnR();
            expect(adminRnR.rewardRateInBpsForEA).to.equal(300);
            expect(adminRnR.rewardRateInBpsForPoolOwner).to.equal(200);
            expect(adminRnR.liquidityRateInBpsByEA).to.equal(200);
            expect(adminRnR.liquidityRateInBpsByPoolOwner).to.equal(200);

            const lpConfig = await poolConfigContract.getLPConfig();
            expect(lpConfig.maxSeniorJuniorRatio).to.equal(4);
        });
        it("Should reject non-owner's call to initialize()", async function () {
            await expect(
                poolConfigContract
                    .connect(regularUser)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.getAddress(),
                        mockTokenContract.getAddress(),
                        platformFeeManagerContract.getAddress(),
                        poolVaultContract.getAddress(),
                        calendarContract.getAddress(),
                        poolOwnerAndEAFirstLossCoverContract.getAddress(),
                        tranchesPolicyContract.getAddress(),
                        poolContract.getAddress(),
                        epochManagerContract.getAddress(),
                        seniorTrancheVaultContract.getAddress(),
                        juniorTrancheVaultContract.getAddress(),
                        creditContract.getAddress(),
                        creditFeeManagerContract.getAddress(),
                        creditPnlManagerContract.getAddress(),
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "notPoolOwner");
        });
        it("Should reject zero address for HumaConfig", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        ethers.ZeroAddress,
                        mockTokenContract.getAddress(),
                        platformFeeManagerContract.getAddress(),
                        poolVaultContract.getAddress(),
                        calendarContract.getAddress(),
                        poolOwnerAndEAFirstLossCoverContract.getAddress(),
                        tranchesPolicyContract.getAddress(),
                        poolContract.getAddress(),
                        epochManagerContract.getAddress(),
                        seniorTrancheVaultContract.getAddress(),
                        juniorTrancheVaultContract.getAddress(),
                        creditContract.getAddress(),
                        creditFeeManagerContract.getAddress(),
                        creditPnlManagerContract.getAddress(),
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject invalid underlying tokens", async function () {
            await humaConfigContract
                .connect(protocolOwner)
                .setLiquidityAsset(mockTokenContract.getAddress(), false);
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.getAddress(),
                        ethers.ZeroAddress,
                        platformFeeManagerContract.getAddress(),
                        poolVaultContract.getAddress(),
                        calendarContract.getAddress(),
                        poolOwnerAndEAFirstLossCoverContract.getAddress(),
                        tranchesPolicyContract.getAddress(),
                        poolContract.getAddress(),
                        epochManagerContract.getAddress(),
                        seniorTrancheVaultContract.getAddress(),
                        juniorTrancheVaultContract.getAddress(),
                        creditContract.getAddress(),
                        creditFeeManagerContract.getAddress(),
                        creditPnlManagerContract.getAddress(),
                    ]),
            ).to.be.revertedWithCustomError(
                poolConfigContract,
                "underlyingTokenNotApprovedForHumaProtocol",
            );
        });
        it("Should reject zero address for platformFeeManager", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.getAddress(),
                        mockTokenContract.getAddress(),
                        ethers.ZeroAddress,
                        poolVaultContract.getAddress(),
                        calendarContract.getAddress(),
                        poolOwnerAndEAFirstLossCoverContract.getAddress(),
                        tranchesPolicyContract.getAddress(),
                        poolContract.getAddress(),
                        epochManagerContract.getAddress(),
                        seniorTrancheVaultContract.getAddress(),
                        juniorTrancheVaultContract.getAddress(),
                        creditContract.getAddress(),
                        creditFeeManagerContract.getAddress(),
                        creditPnlManagerContract.getAddress(),
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for poolVault", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.getAddress(),
                        mockTokenContract.getAddress(),
                        platformFeeManagerContract.getAddress(),
                        ethers.ZeroAddress,
                        calendarContract.getAddress(),
                        poolOwnerAndEAFirstLossCoverContract.getAddress(),
                        tranchesPolicyContract.getAddress(),
                        poolContract.getAddress(),
                        epochManagerContract.getAddress(),
                        seniorTrancheVaultContract.getAddress(),
                        juniorTrancheVaultContract.getAddress(),
                        creditContract.getAddress(),
                        creditFeeManagerContract.getAddress(),
                        creditPnlManagerContract.getAddress(),
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for calendar", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.getAddress(),
                        mockTokenContract.getAddress(),
                        platformFeeManagerContract.getAddress(),
                        poolVaultContract.getAddress(),
                        ethers.ZeroAddress,
                        poolOwnerAndEAFirstLossCoverContract.getAddress(),
                        tranchesPolicyContract.getAddress(),
                        poolContract.getAddress(),
                        epochManagerContract.getAddress(),
                        seniorTrancheVaultContract.getAddress(),
                        juniorTrancheVaultContract.getAddress(),
                        creditContract.getAddress(),
                        creditFeeManagerContract.getAddress(),
                        creditPnlManagerContract.getAddress(),
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for poolOwnerAndEAFirstLossCover", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.getAddress(),
                        mockTokenContract.getAddress(),
                        platformFeeManagerContract.getAddress(),
                        poolVaultContract.getAddress(),
                        calendarContract.getAddress(),
                        ethers.ZeroAddress,
                        tranchesPolicyContract.getAddress(),
                        poolContract.getAddress(),
                        epochManagerContract.getAddress(),
                        seniorTrancheVaultContract.getAddress(),
                        juniorTrancheVaultContract.getAddress(),
                        creditContract.getAddress(),
                        creditFeeManagerContract.getAddress(),
                        creditPnlManagerContract.getAddress(),
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for tranchePolicy", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.getAddress(),
                        mockTokenContract.getAddress(),
                        platformFeeManagerContract.getAddress(),
                        poolVaultContract.getAddress(),
                        calendarContract.getAddress(),
                        poolOwnerAndEAFirstLossCoverContract.getAddress(),
                        ethers.ZeroAddress,
                        poolContract.getAddress(),
                        epochManagerContract.getAddress(),
                        seniorTrancheVaultContract.getAddress(),
                        juniorTrancheVaultContract.getAddress(),
                        creditContract.getAddress(),
                        creditFeeManagerContract.getAddress(),
                        creditPnlManagerContract.getAddress(),
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for the pool", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.getAddress(),
                        mockTokenContract.getAddress(),
                        platformFeeManagerContract.getAddress(),
                        poolVaultContract.getAddress(),
                        calendarContract.getAddress(),
                        poolOwnerAndEAFirstLossCoverContract.getAddress(),
                        tranchesPolicyContract.getAddress(),
                        ethers.ZeroAddress,
                        epochManagerContract.getAddress(),
                        seniorTrancheVaultContract.getAddress(),
                        juniorTrancheVaultContract.getAddress(),
                        creditContract.getAddress(),
                        creditFeeManagerContract.getAddress(),
                        creditPnlManagerContract.getAddress(),
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for epochManager", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.getAddress(),
                        mockTokenContract.getAddress(),
                        platformFeeManagerContract.getAddress(),
                        poolVaultContract.getAddress(),
                        calendarContract.getAddress(),
                        poolOwnerAndEAFirstLossCoverContract.getAddress(),
                        tranchesPolicyContract.getAddress(),
                        poolContract.getAddress(),
                        ethers.ZeroAddress,
                        seniorTrancheVaultContract.getAddress(),
                        juniorTrancheVaultContract.getAddress(),
                        creditContract.getAddress(),
                        creditFeeManagerContract.getAddress(),
                        creditPnlManagerContract.getAddress(),
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for seniorTranche", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.getAddress(),
                        mockTokenContract.getAddress(),
                        platformFeeManagerContract.getAddress(),
                        poolVaultContract.getAddress(),
                        calendarContract.getAddress(),
                        poolOwnerAndEAFirstLossCoverContract.getAddress(),
                        tranchesPolicyContract.getAddress(),
                        poolContract.getAddress(),
                        epochManagerContract.getAddress(),
                        ethers.ZeroAddress,
                        juniorTrancheVaultContract.getAddress(),
                        creditContract.getAddress(),
                        creditFeeManagerContract.getAddress(),
                        creditPnlManagerContract.getAddress(),
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for juniorTranche", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.getAddress(),
                        mockTokenContract.getAddress(),
                        platformFeeManagerContract.getAddress(),
                        poolVaultContract.getAddress(),
                        calendarContract.getAddress(),
                        poolOwnerAndEAFirstLossCoverContract.getAddress(),
                        tranchesPolicyContract.getAddress(),
                        poolContract.getAddress(),
                        epochManagerContract.getAddress(),
                        seniorTrancheVaultContract.getAddress(),
                        ethers.ZeroAddress,
                        creditContract.getAddress(),
                        creditFeeManagerContract.getAddress(),
                        creditPnlManagerContract.getAddress(),
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for credit", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.getAddress(),
                        mockTokenContract.getAddress(),
                        platformFeeManagerContract.getAddress(),
                        poolVaultContract.getAddress(),
                        calendarContract.getAddress(),
                        poolOwnerAndEAFirstLossCoverContract.getAddress(),
                        tranchesPolicyContract.getAddress(),
                        poolContract.getAddress(),
                        epochManagerContract.getAddress(),
                        seniorTrancheVaultContract.getAddress(),
                        juniorTrancheVaultContract.getAddress(),
                        ethers.ZeroAddress,
                        creditFeeManagerContract.getAddress(),
                        creditPnlManagerContract.getAddress(),
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for creditFeeManager", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.getAddress(),
                        mockTokenContract.getAddress(),
                        platformFeeManagerContract.getAddress(),
                        poolVaultContract.getAddress(),
                        calendarContract.getAddress(),
                        poolOwnerAndEAFirstLossCoverContract.getAddress(),
                        tranchesPolicyContract.getAddress(),
                        poolContract.getAddress(),
                        epochManagerContract.getAddress(),
                        seniorTrancheVaultContract.getAddress(),
                        juniorTrancheVaultContract.getAddress(),
                        creditContract.getAddress(),
                        ethers.ZeroAddress,
                        creditPnlManagerContract.getAddress(),
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for creditPnLManager", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.getAddress(),
                        mockTokenContract.getAddress(),
                        platformFeeManagerContract.getAddress(),
                        poolVaultContract.getAddress(),
                        calendarContract.getAddress(),
                        poolOwnerAndEAFirstLossCoverContract.getAddress(),
                        tranchesPolicyContract.getAddress(),
                        poolContract.getAddress(),
                        epochManagerContract.getAddress(),
                        seniorTrancheVaultContract.getAddress(),
                        juniorTrancheVaultContract.getAddress(),
                        creditContract.getAddress(),
                        creditFeeManagerContract.getAddress(),
                        ethers.ZeroAddress,
                    ]),
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject repeated call to initialize()", async function () {
            await poolConfigContract
                .connect(poolOwner)
                .initialize("Base Credit Pool", [
                    humaConfigContract.getAddress(),
                    mockTokenContract.getAddress(),
                    platformFeeManagerContract.getAddress(),
                    poolVaultContract.getAddress(),
                    calendarContract.getAddress(),
                    poolOwnerAndEAFirstLossCoverContract.getAddress(),
                    tranchesPolicyContract.getAddress(),
                    poolContract.getAddress(),
                    epochManagerContract.getAddress(),
                    seniorTrancheVaultContract.getAddress(),
                    juniorTrancheVaultContract.getAddress(),
                    creditContract.getAddress(),
                    creditFeeManagerContract.getAddress(),
                    creditPnlManagerContract.getAddress(),
                ]);
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize("Base Credit Pool", [
                        humaConfigContract.getAddress(),
                        mockTokenContract.getAddress(),
                        platformFeeManagerContract.getAddress(),
                        poolVaultContract.getAddress(),
                        calendarContract.getAddress(),
                        poolOwnerAndEAFirstLossCoverContract.getAddress(),
                        tranchesPolicyContract.getAddress(),
                        poolContract.getAddress(),
                        epochManagerContract.getAddress(),
                        seniorTrancheVaultContract.getAddress(),
                        juniorTrancheVaultContract.getAddress(),
                        creditContract.getAddress(),
                        creditFeeManagerContract.getAddress(),
                        creditPnlManagerContract.getAddress(),
                    ]),
            ).to.revertedWith("Initializable: contract is already initialized");
        });
    });

    it("setPoolName", async function () {
        const poolName = "TestPoolName";
        await poolConfigContract.setPoolName(poolName);
        expect(await poolConfigContract.poolName()).to.equal(poolName);
    });
});
