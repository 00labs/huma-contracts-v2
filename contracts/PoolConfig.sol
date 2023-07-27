// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CalendarUnit} from "./SharedDefs.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
//import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC20, IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IPlatformFeeManager} from "./interfaces/IPlatformFeeManager.sol";
import {IPool} from "./interfaces/IPool.sol";

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "./SharedDefs.sol";

import {HumaConfig} from "./HumaConfig.sol";
import {Errors} from "./Errors.sol";

import "hardhat/console.sol";

struct PoolSettings {
    // the maximum credit line for an address in terms of the amount of poolTokens
    uint96 maxCreditLine;
    // calendarType and numPerPeriod are used together to measure the duration
    // of a pay period. For example, 14 days, 2 SemiMonth (1 month), 6 SemiMonth (1 quarter)
    CalendarUnit calendarUnit;
    uint8 payPeriodInCalendarUnit;
    // the duration of a credit line without an initial drawdown
    uint16 creditApprovalExpirationInDays;
    // the grace period before a late fee can be charged, in the unit of number of days
    uint8 latePaymentGracePeriodInDays;
    // the grace period before a default can be triggered, in the unit of the pool's CalendarUnit
    uint16 defaultGracePeriodInCalendarUnit;
    // percentage of the receivable amount applied towards available credit
    uint16 advanceRateInBps;
    // if the pool is exclusive to one borrower
    bool singleBorrower;
    // if the dues are combined into one credit if the borrower has multiple receivables
    bool singleCreditPerBorrower;
    // if flexCredit is enabled
    bool flexCreditEnabled;
}

/**
 * @notice Rewards and Responsibilities for various admins
 */
struct AdminRnR {
    // Percentage of pool income allocated to EA
    uint16 rewardRateInBpsForEA;
    // Percentage of pool income allocated to Pool Owner
    uint16 rewardRateInBpsForPoolOwner;
    // Percentage of the _liquidityCap to be contributed by EA
    uint16 liquidityRateInBpsByEA;
    // Percentage of the _liquidityCap to be contributed by Pool Owner
    uint16 liquidityRateInBpsByPoolOwner;
    uint16 rewardRateInBpsForPoolCover;
    uint16 liquidityRateInBpsByPoolCover;
}

struct LPConfig {
    // whether approval is required for an LP to participate
    bool permissioned;
    // The max liquidity allowed for the pool.
    uint96 liquidityCap;
    // How long a lender has to wait after the last deposit before they can withdraw
    uint8 withdrawalLockoutInCalendarUnit;
    // The upper bound of senior-to-junior ratio allowed
    uint8 maxSeniorJuniorRatio;
    // The fixed yield for senior tranche. Either this or tranchesRiskAdjustmentInBps is non-zero
    uint16 fixedSeniorYieldInBps;
    // Percentage of yield to be shifted from senior to junior. Either this or fixedSeniorYieldInBps is non-zero
    uint16 tranchesRiskAdjustmentInBps;
    // The duration of an epoch, in the unit of full CalendarUnit
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

struct FrontLoadingFeesStructure {
    /// Part of platform fee, charged as a flat amount when a borrow happens
    uint96 frontLoadingFeeFlat;
    /// Part of platform fee, charged as a % of the borrowing amount when a borrow happens
    uint16 frontLoadingFeeBps;
}

struct FeeStructure {
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

//contract PoolConfig is Ownable, Initializable {
contract PoolConfig is Ownable {
    uint256 constant WITHDRAWAL_LOCKOUT_PERIOD_IN_SECONDS = SECONDS_IN_180_DAYS;

    //using SafeERC20 for IERC20;

    string public poolName;

    address public pool;
    address public poolVault;
    address public seniorTranche;
    address public juniorTranche;
    address public tranchesPolicy;
    address public epochManager;
    address[] internal _lossCoverers;
    address public credit;
    address public feeManager;

    HumaConfig public humaConfig;

    // The ERC20 token this pool manages
    address public underlyingToken;

    // Evaluation Agents (EA) are the risk underwriting agents that associated with the pool.
    address public evaluationAgent;

    uint256 public evaluationAgentId;

    PoolSettings internal _poolSettings;
    LPConfig internal _lpConfig;
    AdminRnR internal _adminRnR;
    FirstLossCover internal _firstLossCover;
    FrontLoadingFeesStructure internal _frontFees;
    FeeStructure internal _feeStructure;

    // TODO replace to openzeppelin access control?
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

    function getTrancheLiquidityCap(uint256 index) external view returns (uint256 cap) {
        LPConfig memory lpc = _lpConfig;
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
        address _underlyingToken,
        address _humaConfig,
        address _feeManager
    )
        public
        //) public onlyOwner initializer {
        onlyOwner
    {
        poolName = _poolName;
        if (_humaConfig == address(0)) revert Errors.zeroAddressProvided();
        if (_feeManager == address(0)) revert Errors.zeroAddressProvided();

        humaConfig = HumaConfig(_humaConfig);

        if (!humaConfig.isAssetValid(_underlyingToken))
            revert Errors.underlyingTokenNotApprovedForHumaProtocol();
        underlyingToken = _underlyingToken;

        feeManager = _feeManager;

        // Default values for the pool configurations. The pool owners are expected to reset
        // these values when setting up the pools. Setting these default values to avoid
        // strange behaviors when the pool owner missed setting up these configurations.
        // _liquidityCap, _maxCreditLine, _creditApprovalExpirationInSeconds are left at 0.
        PoolSettings memory _pSettings = _poolSettings;
        _pSettings.calendarUnit = CalendarUnit.Month;
        _pSettings.payPeriodInCalendarUnit = 2; // 1 month
        _pSettings.advanceRateInBps = 10000; // 100%
        _pSettings.latePaymentGracePeriodInDays = 5;
        _pSettings.defaultGracePeriodInCalendarUnit = 6; // 3 months

        _adminRnR.rewardRateInBpsForEA = 300; //3%
        _adminRnR.rewardRateInBpsForPoolOwner = 200; //2%
        _adminRnR.liquidityRateInBpsByEA = 200; // 2%
        _adminRnR.liquidityRateInBpsByPoolOwner = 200; // 2%
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

    /**
     * @notice change the default APR for the pool
     * @param _yieldInBps expected yield in basis points, use 500 for 5%
     */
    function setYield(uint256 _yieldInBps) external {
        _onlyOwnerOrHumaMasterAdmin();
        _feeStructure.yieldInBps = uint16(_yieldInBps);
        emit YieldChanged(_yieldInBps, msg.sender);
    }

    function setCreditApprovalExpiration(uint256 durationInDays) external {
        _onlyOwnerOrHumaMasterAdmin();
        _poolSettings.creditApprovalExpirationInDays = uint16(durationInDays);
        emit CreditApprovalExpirationChanged(durationInDays, msg.sender);
    }

    function setPoolOwnerRewardsAndLiquidity(uint256 rewardsRate, uint256 liquidityRate) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (rewardsRate > HUNDRED_PERCENT_IN_BPS || liquidityRate > HUNDRED_PERCENT_IN_BPS)
            revert Errors.invalidBasisPointHigherThan10000();

        _adminRnR.rewardRateInBpsForPoolOwner = uint16(rewardsRate);
        _adminRnR.liquidityRateInBpsByPoolOwner = uint16(liquidityRate);
        emit PoolOwnerRewardsAndLiquidityChanged(rewardsRate, liquidityRate, msg.sender);
    }

    function setEARewardsAndLiquidity(uint256 rewardsRate, uint256 liquidityRate) external {
        _onlyOwnerOrHumaMasterAdmin();

        if (rewardsRate > HUNDRED_PERCENT_IN_BPS || liquidityRate > HUNDRED_PERCENT_IN_BPS)
            revert Errors.invalidBasisPointHigherThan10000();
        _adminRnR.rewardRateInBpsForEA = uint16(rewardsRate);
        _adminRnR.liquidityRateInBpsByEA = uint16(liquidityRate);
        emit EARewardsAndLiquidityChanged(rewardsRate, liquidityRate, msg.sender);
    }

    /**
     * @notice Adds an evaluation agent to the list who can approve loans.
     * @param agent the evaluation agent to be added
     */
    function setEvaluationAgent(uint256 eaId, address agent) external {
        if (agent == address(0)) revert Errors.zeroAddressProvided();
        _onlyOwnerOrHumaMasterAdmin();

        if (IERC721(humaConfig.eaNFTContractAddress()).ownerOf(eaId) != agent)
            revert Errors.proposedEADoesNotOwnProvidedEANFT();

        address oldEA = evaluationAgent;
        if (oldEA != address(0)) {
            IPlatformFeeManager fm = IPlatformFeeManager(feeManager);
            (, , uint256 eaWithdrawable) = fm.getWithdrawables();
            fm.withdrawEAFee(eaWithdrawable);
        }

        // Make sure the new EA has met the liquidity requirements
        // todo uncomment and fix it
        // if (BasePool(pool).isPoolOn()) {
        // checkLiquidityRequirementForEA(poolToken.withdrawableFundsOf(agent));
        // }

        // Transfer the accrued EA income to the old EA's wallet.
        // Decided not to check if there is enough balance in the pool. If there is
        // not enough balance, the transaction will fail. PoolOwner has to find enough
        // liquidity to pay the EA before replacing it.

        evaluationAgent = agent;
        evaluationAgentId = eaId;

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
        _poolSettings.maxCreditLine = uint96(creditLine);
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
        if (unit != _poolSettings.calendarUnit) revert();
        _poolSettings.defaultGracePeriodInCalendarUnit = uint16(gracePeriod);
        emit PoolDefaultGracePeriodChanged(gracePeriod, msg.sender);
    }

    /**
     * @notice Sets the cap of the pool liquidity.
     * @param liquidityCap the upper bound that the pool accepts liquidity from the depositors
     */
    function setPoolLiquidityCap(uint256 liquidityCap) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (liquidityCap == 0) revert Errors.zeroAmountProvided();
        _lpConfig.liquidityCap = uint96(liquidityCap);
        emit PoolLiquidityCapChanged(liquidityCap, msg.sender);
    }

    function setPoolPayPeriod(CalendarUnit unit, uint256 number) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (number == 0) revert Errors.zeroAmountProvided();
        PoolSettings memory _settings = _poolSettings;
        _settings.calendarUnit = unit;
        _settings.payPeriodInCalendarUnit = uint8(number);
        _poolSettings = _settings;
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

    function setPoolUnderlyingToken(address _underlyingToken) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_underlyingToken == address(0)) revert Errors.zeroAddressProvided();
        underlyingToken = _underlyingToken;
        // todo emit event
    }

    function setTranches(address _seniorTranche, address _juniorTranche) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (seniorTranche == address(0) || juniorTranche == address(0))
            revert Errors.zeroAddressProvided();
        seniorTranche = _seniorTranche;
        juniorTranche = _juniorTranche;
        // todo emit event
    }

    function setPoolVault(address _poolVault) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_poolVault == address(0)) revert Errors.zeroAddressProvided();
        poolVault = _poolVault;
        // todo emit event
    }

    function setTranchesPolicy(address _tranchesPolicy) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_tranchesPolicy == address(0)) revert Errors.zeroAddressProvided();
        tranchesPolicy = _tranchesPolicy;
        // todo emit event
    }

    function setEpochManager(address _epochManager) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_epochManager == address(0)) revert Errors.zeroAddressProvided();
        epochManager = _epochManager;
        // todo emit event
    }

    function setCredit(address _credit) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (_credit == address(0)) revert Errors.zeroAddressProvided();
        credit = _credit;
        // todo emit event
    }

    function setLossCoverers(address[] calldata lossCoverers) external {
        _onlyOwnerOrHumaMasterAdmin();
        for (uint256 i = 0; i < lossCoverers.length; i++) {
            _lossCoverers.push(lossCoverers[i]);
        }
        // todo emit event
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
        _poolSettings.advanceRateInBps = uint16(receivableInBps);
        emit ReceivableRequiredInBpsChanged(receivableInBps, msg.sender);
    }

    /**
     * Sets withdrawal lockout period after the lender makes the last deposit
     * @param lockoutPeriod the lockout period in terms of days
     */
    function setWithdrawalLockoutPeriod(CalendarUnit unit, uint256 lockoutPeriod) external {
        _onlyOwnerOrHumaMasterAdmin();
        if (unit != _poolSettings.calendarUnit) revert();
        _lpConfig.withdrawalLockoutInCalendarUnit = uint8(lockoutPeriod);
        emit WithdrawalLockoutPeriodChanged(lockoutPeriod, msg.sender);
    }

    function checkLiquidityRequirementForPoolOwner(uint256 balance) public view {
        if (
            balance <
            (_lpConfig.liquidityCap * _poolSettings.advanceRateInBps) / HUNDRED_PERCENT_IN_BPS
        ) revert Errors.poolOwnerNotEnoughLiquidity();
    }

    function checkLiquidityRequirementForEA(uint256 balance) public view {
        if (
            balance <
            (_lpConfig.liquidityCap * _poolSettings.advanceRateInBps) / HUNDRED_PERCENT_IN_BPS
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
            _feeStructure.yieldInBps,
            _poolSettings.payPeriodInCalendarUnit,
            _poolSettings.maxCreditLine,
            _lpConfig.liquidityCap,
            erc20Contract.name(),
            erc20Contract.symbol(),
            erc20Contract.decimals(),
            evaluationAgentId,
            humaConfig.eaNFTContractAddress()
        );
    }

    function getLPConfig() external view returns (LPConfig memory) {
        return _lpConfig;
    }

    function getAdminRnR() external view returns (AdminRnR memory) {
        return _adminRnR;
    }

    function getFirstLossCover() external view returns (FirstLossCover memory) {
        return _firstLossCover;
    }

    function getLossCoverers() external view returns (address[] memory) {
        return _lossCoverers;
    }

    function getPoolSettings() external view returns (PoolSettings memory) {
        return _poolSettings;
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

    function onlyPoolOwnerTreasury(address account) public view returns (address) {
        if (account != poolOwnerTreasury) revert Errors.notPoolOwnerTreasury();
        return poolOwnerTreasury;
    }

    /// "Modifier" function that limits access to pool owner or EA.
    function onlyPoolOwnerOrEA(address account) public view returns (address) {
        if (account != owner() && account != evaluationAgent && account != address(this))
            revert Errors.notPoolOwnerOrEA();
        return evaluationAgent;
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

    /// "Modifier" function that limits access to pool owner or Huma protocol owner
    function _onlyOwnerOrHumaMasterAdmin() internal view {
        onlyOwnerOrHumaMasterAdmin(msg.sender);
    }

    function getFrontLoadingFee() external view returns (uint256, uint256) {
        return (_frontFees.frontLoadingFeeFlat, _frontFees.frontLoadingFeeBps);
    }

    /**
     * @notice Gets the fee structure for the pool
     */
    function getFees()
        external
        view
        virtual
        returns (uint256 _lateFeeFlat, uint256 _lateFeeBps, uint256 _membershipFee)
    {
        return (_feeStructure.lateFeeFlat, _feeStructure.lateFeeBps, _feeStructure.membershipFee);
    }

    function getMinPrincipalRateInBps() external view virtual returns (uint256 _minPrincipalRate) {
        return _feeStructure.minPrincipalRateInBps;
    }

    function setLPConfig(LPConfig calldata lpConfig) external {
        _onlyOwnerOrHumaMasterAdmin();
        _lpConfig = lpConfig;
        // todo emit event
    }

    function setFirstLossCoverConfig(FirstLossCover calldata firstLossCover) external {
        _onlyOwnerOrHumaMasterAdmin();
        _firstLossCover = firstLossCover;
        // todo emit event
    }

    function setFrontLoadingFees(FrontLoadingFeesStructure calldata frontFees) external {
        _onlyOwnerOrHumaMasterAdmin();
        _frontFees = frontFees;
        // todo emit event
    }

    function setFees(FeeStructure calldata feeStructure) external {
        _onlyOwnerOrHumaMasterAdmin();
        _feeStructure = feeStructure;
        // todo emit event
    }

    function onlyEpochManager(address account) external view {
        if (account != epochManager) revert Errors.notEpochManager();
    }

    function onlyPlatformFeeManager(address account) external view {
        if (account != feeManager) revert Errors.notPlatformFeeManager();
    }

    function onlyPool(address account) external view {
        if (account != pool) revert Errors.notPool();
    }

    function onlyTrancheVaultOrLossCoverer(address account) external view {
        bool valid;
        if (account == seniorTranche || account == juniorTranche) return;
        uint256 len = _lossCoverers.length;
        for (uint256 i; i < len; i++) {
            if (account == _lossCoverers[i]) return;
        }

        if (!valid) revert Errors.notTrancheVaultOrLossCoverer();
    }

    function onlyTrancheVaultOrEpochManager(address account) external view {
        if (account != seniorTranche && account != seniorTranche && account != epochManager)
            revert Errors.notTrancheVaultOrEpochManager();
    }

    function onlyPoolOperator(address account) external view {
        if (!poolOperators[account]) revert Errors.poolOperatorRequired();
    }

    function onlyProtocolAndPoolOn() external view {
        if (humaConfig.paused()) revert Errors.protocolIsPaused();
        if (IPool(pool).isPoolOn()) revert Errors.poolIsNotOn();
    }
}
