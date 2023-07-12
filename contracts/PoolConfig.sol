// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
//import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC20, IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Constants} from "./Constants.sol";

//import "./HDT/HDT.sol";
import "./HumaConfig.sol";
//import "./BasePool.sol";
import "./Errors.sol";

import "hardhat/console.sol";

enum CalendarUnit {
    Day,
    SemiMonth // half a month.
}

struct PoolSettings {
    // calendarType and numPerPeriod are used together to measure the duration
    // of a pay period. For example, 14 days, 2 SemiMonth (1 month), 6 SemiMonth (1 quarter)
    CalendarUnit calendarUnit;
    uint16 payPeriodInCalendarUnit;
    // the maximum credit line for an address in terms of the amount of poolTokens
    uint96 maxCreditLine;
    // the duration of a credit line without an initial drawdown
    uint16 creditApprovalExpirationInDays;
    // Percentage of receivable required for credits in this pool in terms of basis points
    // For over receivableization, use more than 100%, for no receivable, use 0.
    uint16 receivableRequiredInBps;
    // the grace period before a late fee can be charged, in the unit of number of days
    uint16 latePaymentGracePeriodInDays;
    // the grace period before a default can be triggered, in the unit of the pool's CalendarUnit
    uint16 defaultGracePeriodInCalendarUnit;
    // Percentage of pool income allocated to EA
    uint16 rewardRateInBpsForEA;
    // Percentage of pool income allocated to Pool Owner
    uint16 rewardRateInBpsForPoolOwner;
    // Percentage of the _liquidityCap to be contributed by EA
    uint16 liquidityRateInBpsByEA;
    // Percentage of the _liquidityCap to be contributed by Pool Owner
    uint16 liquidityRateInBpsByPoolOwner;
}

struct LPConfig {
    // whether approval is required for an LP to participate
    bool permissioned;
    // The max liquidity allowed for the pool.
    uint96 liquidityCap;
    // How long a lender has to wait after the last deposit before they can withdraw
    uint16 withdrawalLockoutInCalendarUnit;
    // The upper bound of senior-to-junior ratio allowed
    uint8 maxSeniorJuniorRatio;
    // The fixed yield for senior tranche. Either this or tranchesRiskAdjustmentInBps is non-zero
    uint16 fixedSeniorYieldInBps;
    // Percentage of yield to be shifted from senior to junior. Either this or fixedSeniorYieldInBps is non-zero
    uint16 tranchesRiskAdjustmentInBps;
    // The duration of an epoch, in the unit of full CycleType
    uint8 epochWindowInCalendarUnit;
    // The duration between a capital withdraw request and capital availability, in the unit of full CycleType.
    uint8 flexCallWindowInCalendarUnit;
}

struct FirstLossCover {
    // percentage of the pool cap required to be covered by first loss cover
    uint16 poolCapCoverageInBps;
    // percentage of the pool value required to be covered by first loss cover
    uint16 poolValueCoverageInBps;
    // The percentage of a default to be paid by the first loss cover
    uint16 coverRateInBps;
    // The max amount that first loss cover can spend on one default
    uint96 coverCap;
}

struct FeeStructure {
    /// Part of platform fee, charged as a flat amount when a borrow happens
    uint96 frontLoadingFeeFlat;
    /// Part of platform fee, charged as a % of the borrowing amount when a borrow happens
    uint96 frontLoadingFeeBps;
    // Expected yield in basis points
    uint16 yieldInBps;
    ///The min % of the outstanding principal to be paid in the statement for each each period
    uint16 minPrincipalRateInBps;
    /// Part of late fee, charged as a flat amount when a payment is late
    uint96 lateFeeFlat;
    /// Part of late fee, charged as % of the totaling outstanding balance when a payment is late
    uint16 lateFeeBps;
    // membership fee per pay period. It is a flat fee
    uint96 membershipFee;
}

struct AccruedIncome {
    uint96 protocolIncome;
    uint96 poolOwnerIncome;
    uint96 eaIncome;
}

struct AccruedWithdrawn {
    uint96 protocolIncomeWithdrawn;
    uint96 poolOwnerIncomeWithdrawn;
    uint96 eaIncomeWithdrawn;
}

//contract PoolConfig is Ownable, Initializable {
contract PoolConfig is Ownable {
    uint256 public constant SENIOR_TRANCHE_INDEX = 0;
    uint256 public constant JUNIOR_TRANCHE_INDEX = 1;
    uint256 private constant HUNDRED_PERCENT_IN_BPS = 10000;
    uint256 private constant SECONDS_IN_A_DAY = 1 days;
    uint256 private constant SECONDS_IN_180_DAYS = 180 days;
    uint256 private constant WITHDRAWAL_LOCKOUT_PERIOD_IN_SECONDS = SECONDS_IN_180_DAYS;

    //using SafeERC20 for IERC20;

    string public poolName;

    address public pool;

    HumaConfig public humaConfig;

    address public feeManager;

    IERC20 public poolToken;

    // The ERC20 token this pool manages
    IERC20 public underlyingToken;

    // Evaluation Agents (EA) are the risk underwriting agents that associated with the pool.
    address public evaluationAgent;

    uint256 public evaluationAgentId;

    PoolSettings public poolSettings;
    LPConfig public lpConfig;
    FirstLossCover public firstLossCover;
    FeeStructure public feeStructure;

    AccruedIncome public accuredIncome;

    AccruedWithdrawn public accuredWithdrawn;

    /// Pool operators can add or remove lenders.
    mapping(address => bool) private poolOperators;

    // Address for the account that handles the treasury functions for the pool owner:
    // liquidity deposits, liquidity withdrawls, and reward withdrawals
    address public poolOwnerTreasury;

    event YieldChanged(uint256 aprInBps, address by);
    event CreditApprovalExpirationChanged(uint256 durationInSeconds, address by);
    event EARewardsAndLiquidityChanged(
        uint256 rewardsRate,
        uint256 liquidityRate,
        address indexed by
    );
    event EvaluationAgentChanged(address oldEA, address newEA, uint256 newEAId, address by);
    event EvaluationAgentRewardsWithdrawn(address receiver, uint256 amount, address by);
    event FeeManagerChanged(address feeManager, address by);
    event HDTChanged(address hdt, address udnerlyingToken, address by);
    event HumaConfigChanged(address humaConfig, address by);
    event IncomeDistributed(
        uint256 protocolFee,
        uint256 ownerIncome,
        uint256 eaIncome,
        uint256 poolIncome
    );

    event IncomeReversed(
        uint256 protocolFee,
        uint256 ownerIncome,
        uint256 eaIncome,
        uint256 poolIncome
    );
    event MaxCreditLineChanged(uint256 maxCreditLine, address by);
    event PoolChanged(address pool, address by);
    event PoolDefaultGracePeriodChanged(uint256 gracePeriodInDays, address by);
    event PoolLiquidityCapChanged(uint256 liquidityCap, address by);
    event PoolNameChanged(string name, address by);
    event PoolOwnerRewardsAndLiquidityChanged(
        uint256 rewardsRate,
        uint256 liquidityRate,
        address indexed by
    );
    event PoolOwnerTreasuryChanged(address treasury, address indexed by);
    event PoolPayPeriodChanged(uint256 periodInDays, address by);
    event PoolRewardsWithdrawn(address receiver, uint256 amount);
    event ProtocolRewardsWithdrawn(address receiver, uint256 amount, address by);
    event ReceivableRequiredInBpsChanged(uint256 receivableInBps, address by);
    event WithdrawalLockoutPeriodChanged(uint256 lockoutPeriodInDays, address by);

    /// An operator has been added. An operator is someone who can add or remove approved lenders.
    event PoolOperatorAdded(address indexed operator, address by);

    /// A operator has been removed
    event PoolOperatorRemoved(address indexed operator, address by);

    function getTrancheLiquidityCap(uint256 index) external returns (uint256 cap) {
        LPConfig memory lpc = lpConfig;
        if (index == SENIOR_TRANCHE_INDEX) {
            cap =
                (lpc.liquidityCap * lpc.maxSeniorJuniorRatio) /
                (lpc.maxSeniorJuniorRatio + HUNDRED_PERCENT_IN_BPS);
        } else if (index == JUNIOR_TRANCHE_INDEX) {
            cap = lpc.liquidityCap / (lpc.maxSeniorJuniorRatio + HUNDRED_PERCENT_IN_BPS);
        }
    }

    function initialize(
        string memory _poolName,
        address _poolToken,
        address _humaConfig,
        address _feeManager
    )
        public
        //) public onlyOwner initializer {
        onlyOwner
    {
        poolName = _poolName;
        if (_poolToken == address(0)) revert Errors.zeroAddressProvided();
        if (_humaConfig == address(0)) revert Errors.zeroAddressProvided();
        if (_feeManager == address(0)) revert Errors.zeroAddressProvided();
        //poolToken = HDT(_poolToken);
        // todo change to use the new HDT
        poolToken = IERC20(_poolToken);

        humaConfig = HumaConfig(_humaConfig);

        // todo change to use the new HDT
        address assetTokenAddress = _poolToken; //poolToken.assetToken();

        if (!humaConfig.isAssetValid(assetTokenAddress))
            revert Errors.underlyingTokenNotApprovedForHumaProtocol();
        underlyingToken = IERC20(assetTokenAddress);

        feeManager = _feeManager;

        // Default values for the pool configurations. The pool owners are expected to reset
        // these values when setting up the pools. Setting these default values to avoid
        // strange behaviors when the pool owner missed setting up these configurations.
        // _liquidityCap, _maxCreditLine, _creditApprovalExpirationInSeconds are left at 0.
        PoolSettings memory _pSettings = poolSettings;
        _pSettings.calendarUnit = CalendarUnit.SemiMonth;
        _pSettings.payPeriodInCalendarUnit = 2; // 1 month
        _pSettings.receivableRequiredInBps = 10000; // 100%
        _pSettings.latePaymentGracePeriodInDays = 5;
        _pSettings.defaultGracePeriodInCalendarUnit = 6; // 3 months

        _pSettings.rewardRateInBpsForEA = 300; //3%
        _pSettings.rewardRateInBpsForPoolOwner = 200; //2%
        _pSettings.liquidityRateInBpsByEA = 200; // 2%
        _pSettings.liquidityRateInBpsByPoolOwner = 200; // 2%
    }

    /**
     * @notice Adds a pool operator, who can perform operational tasks for the pool, such as
     * add or remove approved lenders, and disable the pool in eurgent situations. All signers
     * in the pool owner multisig are expected to be pool operators.
     * @param _operator Address to be added to the operator list
     * @dev If address(0) is provided, revert with "zeroAddressProvided()"
     * @dev If the address is already an operator, revert w/ "alreadyAnOperator"
     * @dev Emits a PoolOperatorAdded event.
     */
    function addPoolOperator(address _operator) external onlyOwner {
        if (_operator == address(0)) revert Errors.zeroAddressProvided();
        if (poolOperators[_operator]) revert Errors.alreadyAnOperator();

        poolOperators[_operator] = true;

        emit PoolOperatorAdded(_operator, msg.sender);
    }

    function distributeIncome(uint256 value) external returns (uint256 poolIncome) {
        if (msg.sender != pool) {
            revert Errors.notPool();
        }

        AccruedIncome memory tempIncome = accuredIncome;

        uint256 protocolFee = (uint256(humaConfig.protocolFee()) * value) / HUNDRED_PERCENT_IN_BPS;
        tempIncome.protocolIncome += uint96(protocolFee);

        uint256 valueForPool = value - protocolFee;

        uint256 ownerIncome = (valueForPool * poolSettings.rewardRateInBpsForPoolOwner) /
            HUNDRED_PERCENT_IN_BPS;
        tempIncome.poolOwnerIncome += uint96(ownerIncome);

        uint256 eaIncome = (valueForPool * poolSettings.rewardRateInBpsForEA) /
            HUNDRED_PERCENT_IN_BPS;
        tempIncome.eaIncome += uint96(eaIncome);

        accuredIncome = tempIncome;

        poolIncome = (valueForPool - ownerIncome - eaIncome);

        emit IncomeDistributed(protocolFee, ownerIncome, eaIncome, poolIncome);
    }

    function reverseIncome(uint256 value) external returns (uint256 poolIncome) {
        if (msg.sender != pool) {
            revert Errors.notPool();
        }

        AccruedIncome memory tempIncome = accuredIncome;

        uint256 protocolFee = (uint256(humaConfig.protocolFee()) * value) / HUNDRED_PERCENT_IN_BPS;
        tempIncome.protocolIncome -= uint96(protocolFee);

        uint256 valueForPool = value - protocolFee;

        uint256 ownerIncome = (valueForPool * poolSettings.rewardRateInBpsForPoolOwner) /
            HUNDRED_PERCENT_IN_BPS;
        tempIncome.poolOwnerIncome -= uint96(ownerIncome);

        uint256 eaIncome = (valueForPool * poolSettings.rewardRateInBpsForEA) /
            HUNDRED_PERCENT_IN_BPS;
        tempIncome.eaIncome -= uint96(eaIncome);

        accuredIncome = tempIncome;

        poolIncome = (valueForPool - ownerIncome - eaIncome);

        emit IncomeReversed(protocolFee, ownerIncome, eaIncome, poolIncome);
    }

    /**
     * @notice change the default APR for the pool
     * @param _yieldInBps expected yield in basis points, use 500 for 5%
     */
    function setYield(uint256 _yieldInBps) external {
        _onlyOwnerOrHumaMasterAdmin();
        feeStructure.yieldInBps = uint16(_yieldInBps);
        emit YieldChanged(_yieldInBps, msg.sender);
    }

    function setCreditApprovalExpiration(uint256 durationInDays) external {
        _onlyOwnerOrHumaMasterAdmin();
        poolSettings.creditApprovalExpirationInDays = uint16(durationInDays);
        emit CreditApprovalExpirationChanged(durationInDays, msg.sender);
    }

    function setEARewardsAndLiquidity(uint256 rewardsRate, uint256 liquidityRate) external {
        _onlyOwnerOrHumaMasterAdmin();

        if (rewardsRate > HUNDRED_PERCENT_IN_BPS || liquidityRate > HUNDRED_PERCENT_IN_BPS)
            revert Errors.invalidBasisPointHigherThan10000();
        poolSettings.rewardRateInBpsForEA = uint16(rewardsRate);
        poolSettings.liquidityRateInBpsByEA = uint16(liquidityRate);
        emit EARewardsAndLiquidityChanged(rewardsRate, liquidityRate, msg.sender);
    }

    /**
     * @notice Adds an evaluation agent to the list who can approve loans.
     * @param agent the evaluation agent to be added
     */
    function setEvaluationAgent(uint256 eaId, address agent) external {
        if (agent == address(0)) revert Errors.zeroAddressProvided();
        _onlyOwnerOrHumaMasterAdmin();

        if (IERC721(HumaConfig(humaConfig).eaNFTContractAddress()).ownerOf(eaId) != agent)
            revert Errors.proposedEADoesNotOwnProvidedEANFT();

        // Make sure the new EA has met the liquidity requirements
        // todo uncomment and fix it
        // if (BasePool(pool).isPoolOn()) {
        // checkLiquidityRequirementForEA(poolToken.withdrawableFundsOf(agent));
        // }

        // Transfer the accrued EA income to the old EA's wallet.
        // Decided not to check if there is enough balance in the pool. If there is
        // not enough balance, the transaction will fail. PoolOwner has to find enough
        // liquidity to pay the EA before replacing it.
        address oldEA = evaluationAgent;
        evaluationAgent = agent;
        evaluationAgentId = eaId;

        if (oldEA != address(0)) {
            uint256 rewardsToPayout = accuredIncome.eaIncome - accuredWithdrawn.eaIncomeWithdrawn;
            if (rewardsToPayout > 0) {
                _withdrawEAFee(msg.sender, oldEA, rewardsToPayout);
            }
        }

        emit EvaluationAgentChanged(oldEA, agent, eaId, msg.sender);
    }

    function setFeeManager(address _feeManager) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_feeManager == address(0)) revert Errors.zeroAddressProvided();
        feeManager = _feeManager;
        emit FeeManagerChanged(_feeManager, msg.sender);
    }

    function setHumaConfig(address _humaConfig) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_humaConfig == address(0)) revert Errors.zeroAddressProvided();
        humaConfig = HumaConfig(_humaConfig);
        emit HumaConfigChanged(_humaConfig, msg.sender);
    }

    /**
     * @notice Sets the min and max of each loan/credit allowed by the pool.
     * @param creditLine the max amount of a credit line
     */
    function setMaxCreditLine(uint256 creditLine) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (creditLine == 0) revert Errors.zeroAmountProvided();
        if (creditLine >= 2 ** 96) revert Errors.creditLineTooHigh();
        poolSettings.maxCreditLine = uint96(creditLine);
        emit MaxCreditLineChanged(creditLine, msg.sender);
    }

    function setPool(address _pool) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_pool == address(0)) revert Errors.zeroAddressProvided();
        pool = _pool;
        emit PoolChanged(_pool, msg.sender);
    }

    /**
     * Sets the default grace period for this pool.
     * @param gracePeriod the desired grace period in days.
     */
    function setPoolDefaultGracePeriod(CalendarUnit unit, uint256 gracePeriod) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (unit != poolSettings.calendarUnit) revert();
        poolSettings.defaultGracePeriodInCalendarUnit = uint16(gracePeriod);
        emit PoolDefaultGracePeriodChanged(gracePeriod, msg.sender);
    }

    /**
     * @notice Sets the cap of the pool liquidity.
     * @param liquidityCap the upper bound that the pool accepts liquidity from the depositors
     */
    function setPoolLiquidityCap(uint256 liquidityCap) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (liquidityCap == 0) revert Errors.zeroAmountProvided();
        lpConfig.liquidityCap = uint96(liquidityCap);
        emit PoolLiquidityCapChanged(liquidityCap, msg.sender);
    }

    function setPoolOwnerRewardsAndLiquidity(uint256 rewardsRate, uint256 liquidityRate) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (rewardsRate > HUNDRED_PERCENT_IN_BPS || liquidityRate > HUNDRED_PERCENT_IN_BPS)
            revert Errors.invalidBasisPointHigherThan10000();

        poolSettings.rewardRateInBpsForPoolOwner = uint16(rewardsRate);
        poolSettings.liquidityRateInBpsByPoolOwner = uint16(liquidityRate);
        emit PoolOwnerRewardsAndLiquidityChanged(rewardsRate, liquidityRate, msg.sender);
    }

    function setPoolPayPeriod(CalendarUnit unit, uint256 number) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (number == 0) revert Errors.zeroAmountProvided();
        PoolSettings memory _settings = poolSettings;
        _settings.calendarUnit = unit;
        _settings.payPeriodInCalendarUnit = uint16(number);
        poolSettings = _settings;
        //emit PoolPayPeriodChanged(unit, number, msg.sender);
    }

    /**
     * @notice Change pool name
     */
    function setPoolName(string memory newName) external {
        _onlyOwnerOrHumaMasterAdmin();
        poolName = newName;
        emit PoolNameChanged(newName, msg.sender);
    }

    function setPoolOwnerTreasury(address _poolOwnerTreasury) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_poolOwnerTreasury == address(0)) revert Errors.zeroAddressProvided();
        poolOwnerTreasury = _poolOwnerTreasury;
        emit PoolOwnerTreasuryChanged(_poolOwnerTreasury, msg.sender);
    }

    function setPoolToken(address _poolToken) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_poolToken == address(0)) revert Errors.zeroAddressProvided();
        // todo use the new HDT.
        // poolToken = HDT(_poolToken);
        // address assetToken = poolToken.assetToken();
        // underlyingToken = IERC20(poolToken.assetToken());
        // emit HDTChanged(_poolToken, assetToken, msg.sender);
    }

    /**
     * @notice Set the receivable rate in terms of basis points.
     * When the rate is higher than 10000, it means the backing is higher than the borrow amount,
     * similar to an over-collateral situation.
     * @param receivableInBps the percentage. A percentage over 10000 means overreceivableization.
     */
    function setReceivableRequiredInBps(uint256 receivableInBps) external {
        _onlyOwnerOrHumaMasterAdmin();
        // note: this rate can be over 10000 when it requires more backing than the credit limit
        poolSettings.receivableRequiredInBps = uint16(receivableInBps);
        emit ReceivableRequiredInBpsChanged(receivableInBps, msg.sender);
    }

    /**
     * Sets withdrawal lockout period after the lender makes the last deposit
     * @param lockoutPeriod the lockout period in terms of days
     */
    function setWithdrawalLockoutPeriod(CalendarUnit unit, uint256 lockoutPeriod) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (unit != poolSettings.calendarUnit) revert();
        lpConfig.withdrawalLockoutInCalendarUnit = uint16(lockoutPeriod);
        emit WithdrawalLockoutPeriodChanged(lockoutPeriod, msg.sender);
    }

    function withdrawEAFee(uint256 amount) external {
        // Either Pool owner or EA can trigger reward withdraw for EA.
        // When it is triggered by pool owner, the fund still flows to the EA's account.
        onlyPoolOwnerOrEA(msg.sender);
        if (amount == 0) revert Errors.zeroAmountProvided();
        if (amount + accuredWithdrawn.eaIncomeWithdrawn > accuredIncome.eaIncome)
            revert Errors.withdrawnAmountHigherThanBalance();
        // Note: the transfer can only goes to evaluationAgent
        _withdrawEAFee(msg.sender, evaluationAgent, amount);
    }

    function withdrawPoolOwnerFee(uint256 amount) external {
        onlyPoolOwnerTreasury(msg.sender);
        if (amount == 0) revert Errors.zeroAmountProvided();
        if (amount + accuredWithdrawn.poolOwnerIncomeWithdrawn > accuredIncome.poolOwnerIncome)
            revert Errors.withdrawnAmountHigherThanBalance();
        accuredWithdrawn.poolOwnerIncomeWithdrawn += uint96(amount);
        // todo add it back
        //underlyingToken.safeTransferFrom(pool, msg.sender, amount);
        emit PoolRewardsWithdrawn(msg.sender, amount);
    }

    function withdrawProtocolFee(uint256 amount) external {
        if (msg.sender != humaConfig.owner()) revert Errors.notProtocolOwner();
        if (amount + accuredWithdrawn.protocolIncomeWithdrawn > accuredIncome.protocolIncome)
            revert Errors.withdrawnAmountHigherThanBalance();
        accuredWithdrawn.protocolIncomeWithdrawn += uint96(amount);
        address treasuryAddress = humaConfig.humaTreasury();
        // It is possible that Huma protocolTreasury is missed in the setup. If that happens,
        // the transaction is reverted. The protocol owner can still withdraw protocol fee
        // after protocolTreasury is configured in HumaConfig.
        assert(treasuryAddress != address(0));
        // todo fix it
        // underlyingToken.safeTransferFrom(pool, treasuryAddress, amount);
        emit ProtocolRewardsWithdrawn(treasuryAddress, amount, msg.sender);
    }

    function accruedIncome()
        external
        view
        returns (
            uint256 protocolIncome,
            uint256 poolOwnerIncome,
            uint256 eaIncome,
            uint256 protocolIncomeWithdrawn,
            uint256 poolOwnerIncomeWithdrawn,
            uint256 eaIncomeWithdrawn
        )
    {
        return (
            accuredIncome.protocolIncome,
            accuredIncome.poolOwnerIncome,
            accuredIncome.eaIncome,
            accuredWithdrawn.protocolIncomeWithdrawn,
            accuredWithdrawn.poolOwnerIncomeWithdrawn,
            accuredWithdrawn.eaIncomeWithdrawn
        );
    }

    function checkLiquidityRequirementForPoolOwner(uint256 balance) public view {
        if (
            balance <
            (lpConfig.liquidityCap * poolSettings.liquidityRateInBpsByPoolOwner) /
                HUNDRED_PERCENT_IN_BPS
        ) revert Errors.poolOwnerNotEnoughLiquidity();
    }

    function checkLiquidityRequirementForEA(uint256 balance) public view {
        if (
            balance <
            (lpConfig.liquidityCap * poolSettings.liquidityRateInBpsByEA) / HUNDRED_PERCENT_IN_BPS
        ) revert Errors.evaluationAgentNotEnoughLiquidity();
    }

    /// Checks to make sure both EA and pool owner treasury meet the pool's liquidity requirements
    function checkLiquidityRequirement() public view {
        // todo fix ti
        // checkLiquidityRequirementForPoolOwner(poolToken.withdrawableFundsOf(poolOwnerTreasury));
        // checkLiquidityRequirementForEA(poolToken.withdrawableFundsOf(evaluationAgent));
    }

    /// When the pool owner treasury or EA wants to withdraw liquidity from the pool,
    /// checks to make sure the remaining liquidity meets the pool's requirements
    function checkWithdrawLiquidityRequirement(address lender, uint256 newBalance) public view {
        if (lender == evaluationAgent) {
            checkLiquidityRequirementForEA(newBalance);
        } else if (lender == poolOwnerTreasury) {
            // note poolOwnerTreasury handles all thing financial-related for pool owner
            checkLiquidityRequirementForPoolOwner(newBalance);
        }
    }

    function getCoreData()
        external
        view
        returns (
            address underlyingToken_,
            address poolToken_,
            address humaConfig_,
            address feeManager_
        )
    {
        underlyingToken_ = address(underlyingToken);
        poolToken_ = address(poolToken);
        humaConfig_ = address(humaConfig);
        feeManager_ = feeManager;
    }

    /**
     * Returns a summary information of the pool.
     * @return token the address of the pool token
     * @return apr the default APR of the pool
     * @return payPeriod the standard pay period for the pool
     * @return maxCreditAmount the max amount for the credit line
     */
    function getPoolSummary()
        external
        view
        returns (
            address token,
            uint256 apr,
            uint256 payPeriod,
            uint256 maxCreditAmount,
            uint256 liquiditycap,
            string memory name,
            string memory symbol,
            uint8 decimals,
            uint256 eaId,
            address eaNFTAddress
        )
    {
        IERC20Metadata erc20Contract = IERC20Metadata(address(underlyingToken));
        return (
            address(underlyingToken),
            feeStructure.yieldInBps,
            poolSettings.payPeriodInCalendarUnit,
            poolSettings.maxCreditLine,
            lpConfig.liquidityCap,
            erc20Contract.name(),
            erc20Contract.symbol(),
            erc20Contract.decimals(),
            evaluationAgentId,
            humaConfig.eaNFTContractAddress()
        );
    }

    function isPoolOwnerTreasuryOrEA(address account) public view returns (bool) {
        return (account == poolOwnerTreasury || account == evaluationAgent);
    }

    /// Reports if a given user account is an approved operator or not
    function isOperator(address account) external view returns (bool) {
        return poolOperators[account];
    }

    function onlyPoolOwner(address account) public view {
        if (account != owner()) revert Errors.notPoolOwner();
    }

    function onlyPoolOwnerTreasury(address account) public view {
        if (account != poolOwnerTreasury) revert Errors.notPoolOwnerTreasury();
    }

    /// "Modifier" function that limits access to pool owner or EA.
    function onlyPoolOwnerOrEA(address account) public view {
        if (account != owner() && account != evaluationAgent) revert Errors.notPoolOwnerOrEA();
    }

    /// "Modifier" function that limits access to pool owner treasury or EA.
    function onlyPoolOwnerTreasuryOrEA(address account) public view {
        if (!isPoolOwnerTreasuryOrEA(account)) revert Errors.notPoolOwnerTreasuryOrEA();
    }

    /**
     * @notice Removes a pool operator.
     * @param _operator Address to be removed from the operator list
     * @dev If address(0) is provided, revert with "zeroAddressProvided()"
     * @dev If the address is not currently a operator, revert w/ "notOperator()"
     * @dev Emits a PoolOperatorRemoved event.
     */
    function removePoolOperator(address _operator) external onlyOwner {
        if (_operator == address(0)) revert Errors.zeroAddressProvided();
        if (!poolOperators[_operator]) revert Errors.notOperator();

        poolOperators[_operator] = false;

        emit PoolOperatorRemoved(_operator, msg.sender);
    }

    // Allow for sensitive pool functions only to be called by
    // the pool owner and the huma master admin
    function onlyOwnerOrHumaMasterAdmin(address account) public view {
        if (account != owner() && account != humaConfig.owner()) {
            revert Errors.permissionDeniedNotAdmin();
        }
    }

    function _withdrawEAFee(address caller, address receiver, uint256 amount) internal {
        accuredWithdrawn.eaIncomeWithdrawn += uint96(amount);
        // todo fix it
        // underlyingToken.safeTransferFrom(pool, receiver, amount);

        emit EvaluationAgentRewardsWithdrawn(receiver, amount, caller);
    }

    /// "Modifier" function that limits access to pool owner or Huma protocol owner
    function _onlyOwnerOrHumaMasterAdmin() internal view {
        onlyOwnerOrHumaMasterAdmin(msg.sender);
    }
}
