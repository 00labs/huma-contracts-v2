const {ethers} = require("hardhat");
const {expect} = require("chai");
const {deployProtocolContracts} = require("./BaseTest");
const {loadFixture} = require("@nomicfoundation/hardhat-network-helpers");

let poolConfigContract,
    humaConfigContract,
    mockTokenContract,
    platformFeeManagerContract,
    poolVaultContract,
    calendarContract,
    poolOwnerAndEALossCovererContract,
    tranchesPolicyContract,
    poolContract,
    epochManagerContract,
    seniorTrancheVaultContract,
    juniorTrancheVaultContract,
    creditContract,
    creditFeeManagerContract,
    creditPnlManagerContract,
    protocolOwner,
    poolOwner,
    regularUser;

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
            poolOwner
        );
        const PoolConfig = await ethers.getContractFactory("PoolConfig");
        poolConfigContract = await PoolConfig.deploy();
        await poolConfigContract.deployed();
        await poolConfigContract.grantRole(
            await poolConfigContract.DEFAULT_ADMIN_ROLE(),
            poolOwner.address
        );

        const PlatformFeeManager = await ethers.getContractFactory("PlatformFeeManager");
        platformFeeManagerContract = await PlatformFeeManager.deploy(poolConfigContract.address);
        await platformFeeManagerContract.deployed();

        const PoolVault = await ethers.getContractFactory("PoolVault");
        poolVaultContract = await PoolVault.deploy(poolConfigContract.address);
        await poolVaultContract.deployed();

        const LossCoverer = await ethers.getContractFactory("LossCoverer");
        poolOwnerAndEALossCovererContract = await LossCoverer.deploy(poolConfigContract.address);
        await poolOwnerAndEALossCovererContract.deployed();

        const TranchesPolicy = await ethers.getContractFactory("RiskAdjustedTranchesPolicy");
        tranchesPolicyContract = await TranchesPolicy.deploy(poolConfigContract.address);
        await tranchesPolicyContract.deployed();

        const Pool = await ethers.getContractFactory("Pool");
        poolContract = await Pool.deploy(poolConfigContract.address);
        await poolContract.deployed();

        const EpochManager = await ethers.getContractFactory("EpochManager");
        epochManagerContract = await EpochManager.deploy(poolConfigContract.address);
        await epochManagerContract.deployed();

        const TrancheVault = await ethers.getContractFactory("TrancheVault");
        seniorTrancheVaultContract = await TrancheVault.deploy();
        await seniorTrancheVaultContract.deployed();
        juniorTrancheVaultContract = await TrancheVault.deploy();
        await juniorTrancheVaultContract.deployed();

        const Calendar = await ethers.getContractFactory("Calendar");
        calendarContract = await Calendar.deploy();
        await calendarContract.deployed();

        const Credit = await ethers.getContractFactory("BaseCredit");
        creditContract = await Credit.deploy();
        await creditContract.deployed();

        const BaseCreditFeeManager = await ethers.getContractFactory("BaseCreditFeeManager");
        creditFeeManagerContract = await BaseCreditFeeManager.deploy(poolConfigContract.address);
        await creditFeeManagerContract.deployed();

        const CreditPnLManager = await ethers.getContractFactory("LinearMarkdownPnLManager");
        creditPnlManagerContract = await CreditPnLManager.deploy(poolConfigContract.address);
        await creditPnlManagerContract.deployed();
    }

    beforeEach(async function() {
       await loadFixture(deployPoolConfigContract);
    });

    describe("Pool config initialization", async function () {
        it("Should initialize successfully and sets default values", async function () {
            await poolConfigContract
                    .connect(poolOwner)
                    .initialize(
                        "Base Credit Pool",
                        [
                            humaConfigContract.address,
                            mockTokenContract.address,
                            platformFeeManagerContract.address,
                            poolVaultContract.address,
                            calendarContract.address,
                            poolOwnerAndEALossCovererContract.address,
                            tranchesPolicyContract.address,
                            poolContract.address,
                            epochManagerContract.address,
                            seniorTrancheVaultContract.address,
                            juniorTrancheVaultContract.address,
                            creditContract.address,
                            creditFeeManagerContract.address,
                            creditPnlManagerContract.address
                        ]
                    );

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
                    .initialize(
                        "Base Credit Pool",
                        [
                            humaConfigContract.address,
                            mockTokenContract.address,
                            platformFeeManagerContract.address,
                            poolVaultContract.address,
                            calendarContract.address,
                            poolOwnerAndEALossCovererContract.address,
                            tranchesPolicyContract.address,
                            poolContract.address,
                            epochManagerContract.address,
                            seniorTrancheVaultContract.address,
                            juniorTrancheVaultContract.address,
                            creditContract.address,
                            creditFeeManagerContract.address,
                            creditPnlManagerContract.address
                        ]
                    )
            ).to.be.revertedWithCustomError(poolConfigContract, "notPoolOwner");
        });
        it("Should reject zero address for HumaConfig", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize(
                        "Base Credit Pool",
                        [
                            ethers.constants.AddressZero,
                            mockTokenContract.address,
                            platformFeeManagerContract.address,
                            poolVaultContract.address,
                            calendarContract.address,
                            poolOwnerAndEALossCovererContract.address,
                            tranchesPolicyContract.address,
                            poolContract.address,
                            epochManagerContract.address,
                            seniorTrancheVaultContract.address,
                            juniorTrancheVaultContract.address,
                            creditContract.address,
                            creditFeeManagerContract.address,
                            creditPnlManagerContract.address
                        ]
                    )
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject invalid underlying tokens", async function () {
            await humaConfigContract
                .connect(protocolOwner)
                .setLiquidityAsset(mockTokenContract.address, false);
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize(
                        "Base Credit Pool",
                        [
                            humaConfigContract.address,
                            ethers.constants.AddressZero,
                            platformFeeManagerContract.address,
                            poolVaultContract.address,
                            calendarContract.address,
                            poolOwnerAndEALossCovererContract.address,
                            tranchesPolicyContract.address,
                            poolContract.address,
                            epochManagerContract.address,
                            seniorTrancheVaultContract.address,
                            juniorTrancheVaultContract.address,
                            creditContract.address,
                            creditFeeManagerContract.address,
                            creditPnlManagerContract.address
                        ]
                    )
            ).to.be.revertedWithCustomError(poolConfigContract, "underlyingTokenNotApprovedForHumaProtocol");
        });
        it("Should reject zero address for platformFeeManager", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize(
                        "Base Credit Pool",
                        [
                            humaConfigContract.address,
                            mockTokenContract.address,
                            ethers.constants.AddressZero,
                            poolVaultContract.address,
                            calendarContract.address,
                            poolOwnerAndEALossCovererContract.address,
                            tranchesPolicyContract.address,
                            poolContract.address,
                            epochManagerContract.address,
                            seniorTrancheVaultContract.address,
                            juniorTrancheVaultContract.address,
                            creditContract.address,
                            creditFeeManagerContract.address,
                            creditPnlManagerContract.address
                        ]
                    )
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for poolVault", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize(
                        "Base Credit Pool",
                        [
                            humaConfigContract.address,
                            mockTokenContract.address,
                            platformFeeManagerContract.address,
                            ethers.constants.AddressZero,
                            calendarContract.address,
                            poolOwnerAndEALossCovererContract.address,
                            tranchesPolicyContract.address,
                            poolContract.address,
                            epochManagerContract.address,
                            seniorTrancheVaultContract.address,
                            juniorTrancheVaultContract.address,
                            creditContract.address,
                            creditFeeManagerContract.address,
                            creditPnlManagerContract.address
                        ]
                    )
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for calendar", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize(
                        "Base Credit Pool",
                        [
                            humaConfigContract.address,
                            mockTokenContract.address,
                            platformFeeManagerContract.address,
                            poolVaultContract.address,
                            ethers.constants.AddressZero,
                            poolOwnerAndEALossCovererContract.address,
                            tranchesPolicyContract.address,
                            poolContract.address,
                            epochManagerContract.address,
                            seniorTrancheVaultContract.address,
                            juniorTrancheVaultContract.address,
                            creditContract.address,
                            creditFeeManagerContract.address,
                            creditPnlManagerContract.address
                        ]
                    )
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for poolOwnerOrEALossCoverer", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize(
                        "Base Credit Pool",
                        [
                            humaConfigContract.address,
                            mockTokenContract.address,
                            platformFeeManagerContract.address,
                            poolVaultContract.address,
                            calendarContract.address,
                            ethers.constants.AddressZero,
                            tranchesPolicyContract.address,
                            poolContract.address,
                            epochManagerContract.address,
                            seniorTrancheVaultContract.address,
                            juniorTrancheVaultContract.address,
                            creditContract.address,
                            creditFeeManagerContract.address,
                            creditPnlManagerContract.address
                        ]
                    )
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for tranchePolicy", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize(
                        "Base Credit Pool",
                        [
                            humaConfigContract.address,
                            mockTokenContract.address,
                            platformFeeManagerContract.address,
                            poolVaultContract.address,
                            calendarContract.address,
                            poolOwnerAndEALossCovererContract.address,
                            ethers.constants.AddressZero,
                            poolContract.address,
                            epochManagerContract.address,
                            seniorTrancheVaultContract.address,
                            juniorTrancheVaultContract.address,
                            creditContract.address,
                            creditFeeManagerContract.address,
                            creditPnlManagerContract.address
                        ]
                    )
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for the pool", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize(
                        "Base Credit Pool",
                        [
                            humaConfigContract.address,
                            mockTokenContract.address,
                            platformFeeManagerContract.address,
                            poolVaultContract.address,
                            calendarContract.address,
                            poolOwnerAndEALossCovererContract.address,
                            tranchesPolicyContract.address,
                            ethers.constants.AddressZero,
                            epochManagerContract.address,
                            seniorTrancheVaultContract.address,
                            juniorTrancheVaultContract.address,
                            creditContract.address,
                            creditFeeManagerContract.address,
                            creditPnlManagerContract.address
                        ]
                    )
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for epochManager", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize(
                        "Base Credit Pool",
                        [
                            humaConfigContract.address,
                            mockTokenContract.address,
                            platformFeeManagerContract.address,
                            poolVaultContract.address,
                            calendarContract.address,
                            poolOwnerAndEALossCovererContract.address,
                            tranchesPolicyContract.address,
                            poolContract.address,
                            ethers.constants.AddressZero,
                            seniorTrancheVaultContract.address,
                            juniorTrancheVaultContract.address,
                            creditContract.address,
                            creditFeeManagerContract.address,
                            creditPnlManagerContract.address
                        ]
                    )
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for seniorTranche", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize(
                        "Base Credit Pool",
                        [
                            humaConfigContract.address,
                            mockTokenContract.address,
                            platformFeeManagerContract.address,
                            poolVaultContract.address,
                            calendarContract.address,
                            poolOwnerAndEALossCovererContract.address,
                            tranchesPolicyContract.address,
                            poolContract.address,
                            epochManagerContract.address,
                            ethers.constants.AddressZero,
                            juniorTrancheVaultContract.address,
                            creditContract.address,
                            creditFeeManagerContract.address,
                            creditPnlManagerContract.address
                        ]
                    )
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for juniorTranche", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize(
                        "Base Credit Pool",
                        [
                            humaConfigContract.address,
                            mockTokenContract.address,
                            platformFeeManagerContract.address,
                            poolVaultContract.address,
                            calendarContract.address,
                            poolOwnerAndEALossCovererContract.address,
                            tranchesPolicyContract.address,
                            poolContract.address,
                            epochManagerContract.address,
                            seniorTrancheVaultContract.address,
                            ethers.constants.AddressZero,
                            creditContract.address,
                            creditFeeManagerContract.address,
                            creditPnlManagerContract.address
                        ]
                    )
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for credit", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize(
                        "Base Credit Pool",
                        [
                            humaConfigContract.address,
                            mockTokenContract.address,
                            platformFeeManagerContract.address,
                            poolVaultContract.address,
                            calendarContract.address,
                            poolOwnerAndEALossCovererContract.address,
                            tranchesPolicyContract.address,
                            poolContract.address,
                            epochManagerContract.address,
                            seniorTrancheVaultContract.address,
                            juniorTrancheVaultContract.address,
                            ethers.constants.AddressZero,
                            creditFeeManagerContract.address,
                            creditPnlManagerContract.address
                        ]
                    )
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for creditFeeManager", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize(
                        "Base Credit Pool",
                        [
                            humaConfigContract.address,
                            mockTokenContract.address,
                            platformFeeManagerContract.address,
                            poolVaultContract.address,
                            calendarContract.address,
                            poolOwnerAndEALossCovererContract.address,
                            tranchesPolicyContract.address,
                            poolContract.address,
                            epochManagerContract.address,
                            seniorTrancheVaultContract.address,
                            juniorTrancheVaultContract.address,
                            creditContract.address,
                            ethers.constants.AddressZero,
                            creditPnlManagerContract.address
                        ]
                    )
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject zero address for creditPnLManager", async function () {
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize(
                        "Base Credit Pool",
                        [
                            humaConfigContract.address,
                            mockTokenContract.address,
                            platformFeeManagerContract.address,
                            poolVaultContract.address,
                            calendarContract.address,
                            poolOwnerAndEALossCovererContract.address,
                            tranchesPolicyContract.address,
                            poolContract.address,
                            epochManagerContract.address,
                            seniorTrancheVaultContract.address,
                            juniorTrancheVaultContract.address,
                            creditContract.address,
                            creditFeeManagerContract.address,
                            ethers.constants.AddressZero,
                        ]
                    )
            ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
        });
        it("Should reject repeated call to initialize()", async function () {
            await poolConfigContract
                .connect(poolOwner)
                .initialize(
                    "Base Credit Pool",
                    [
                        humaConfigContract.address,
                        mockTokenContract.address,
                        platformFeeManagerContract.address,
                        poolVaultContract.address,
                        calendarContract.address,
                        poolOwnerAndEALossCovererContract.address,
                        tranchesPolicyContract.address,
                        poolContract.address,
                        epochManagerContract.address,
                        seniorTrancheVaultContract.address,
                        juniorTrancheVaultContract.address,
                        creditContract.address,
                        creditFeeManagerContract.address,
                        creditPnlManagerContract.address,
                    ]
                );
            await expect(
                poolConfigContract
                    .connect(poolOwner)
                    .initialize(
                        "Base Credit Pool",
                        [
                            humaConfigContract.address,
                            mockTokenContract.address,
                            platformFeeManagerContract.address,
                            poolVaultContract.address,
                            calendarContract.address,
                            poolOwnerAndEALossCovererContract.address,
                            tranchesPolicyContract.address,
                            poolContract.address,
                            epochManagerContract.address,
                            seniorTrancheVaultContract.address,
                            juniorTrancheVaultContract.address,
                            creditContract.address,
                            creditFeeManagerContract.address,
                            creditPnlManagerContract.address,
                        ]
                    )
            ).to.revertedWith("Initializable: contract is already initialized");
        });
    });

    it("setPoolName", async function () {
        const poolName = "TestPoolName";
        await poolConfigContract.setPoolName(poolName);
        expect(await poolConfigContract.poolName()).to.equal(poolName);
    });
});
