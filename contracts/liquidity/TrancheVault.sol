// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {Errors} from "../common/Errors.sol";
import {PoolConfig, PoolSettings} from "../common/PoolConfig.sol";
import {PoolConfigCache} from "../common/PoolConfigCache.sol";
import {DEFAULT_DECIMALS_FACTOR, SECONDS_IN_A_DAY} from "../common/SharedDefs.sol";
import {TrancheVaultStorage, IERC20} from "./TrancheVaultStorage.sol";
import {IRedemptionHandler, EpochRedemptionSummary} from "./interfaces/IRedemptionHandler.sol";
import {IEpochManager} from "./interfaces/IEpochManager.sol";
import {ICalendar} from "../common/interfaces/ICalendar.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IPoolSafe} from "./interfaces/IPoolSafe.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {IERC20MetadataUpgradeable, ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract TrancheVault is
    AccessControlUpgradeable,
    ERC20Upgradeable,
    PoolConfigCache,
    TrancheVaultStorage,
    IRedemptionHandler
{
    using SafeERC20 for IERC20;

    bytes32 public constant LENDER_ROLE = keccak256("LENDER");
    uint256 private constant MAX_ALLOWED_NUM_NON_REINVESTING_LENDERS = 100;

    event EpochProcessed(
        uint256 indexed epochId,
        uint256 sharesRequested,
        uint256 sharesProcessed,
        uint256 amountProcessed
    );

    event LiquidityDeposited(
        address indexed sender,
        address indexed receiver,
        uint256 assetAmount,
        uint256 shareAmount
    );

    event LenderFundDisbursed(address indexed account, address receiver, uint256 withdrawnAmount);

    event RedemptionRequestAdded(address indexed account, uint256 shareAmount, uint256 epochId);

    event RedemptionRequestRemoved(address indexed account, uint256 shareAmount, uint256 epochId);

    event YieldPaidout(address indexed account, uint256 yields, uint256 shares);

    event YieldReinvested(address indexed account, uint256 yields);

    event ReinvestYieldConfigSet(address indexed account, bool reinvestYield, address by);

    function initialize(
        string memory name,
        string memory symbol,
        PoolConfig _poolConfig,
        uint8 seniorTrancheOrJuniorTranche
    ) external initializer {
        __ERC20_init(name, symbol);
        __AccessControl_init();
        __UUPSUpgradeable_init();
        _initialize(_poolConfig);

        if (seniorTrancheOrJuniorTranche > 1) revert Errors.invalidTrancheIndex();
        trancheIndex = seniorTrancheOrJuniorTranche;
    }

    /**
     * @notice Lenders need to pass compliance requirements. Pool operator will administer off-chain
     * to make sure potential lenders meet the requirements. Afterwards, the pool operator will
     * call this function to mark a lender as approved.
     */
    function addApprovedLender(address lender, bool reinvestYield) external {
        poolConfig.onlyPoolOperator(msg.sender);
        if (lender == address(0)) revert Errors.zeroAddressProvided();
        if (hasRole(LENDER_ROLE, lender)) revert Errors.alreadyLender();

        _grantRole(LENDER_ROLE, lender);
        depositRecords[lender] = DepositRecord({
            principal: 0,
            reinvestYield: reinvestYield,
            lastDepositTime: 0
        });
        if (!reinvestYield) {
            if (nonReinvestingLenders.length >= MAX_ALLOWED_NUM_NON_REINVESTING_LENDERS)
                revert Errors.nonReinvestYieldLenderCapacityReached();
            nonReinvestingLenders.push(lender);
        }
    }

    /**
     * @notice Removes a lender. This prevents the lender from making more deposits.
     * The capital that the lender has contributed can continue to work as normal.
     */
    function removeApprovedLender(address lender) external {
        poolConfig.onlyPoolOperator(msg.sender);
        if (lender == address(0)) revert Errors.zeroAddressProvided();
        if (!hasRole(LENDER_ROLE, lender)) revert Errors.notLender();
        _revokeRole(LENDER_ROLE, lender);
        if (!depositRecords[lender].reinvestYield) {
            _removeLenderFromNonReinvestingLenders(lender);
        }
        // We intentionally do not delete `depositRecord` for the lender so that they can still
        // request redemption post removal.
    }

    /**
     * @notice The pool operator will call this function to mark whether a lender wants to reinvest yield.
     */
    function setReinvestYield(address lender, bool reinvestYield) external {
        poolConfig.onlyPoolOperator(msg.sender);
        DepositRecord memory depositRecord = depositRecords[lender];
        if (depositRecord.reinvestYield == reinvestYield)
            revert Errors.reinvestYieldOptionAlreadySet();
        if (!depositRecord.reinvestYield && reinvestYield) {
            _removeLenderFromNonReinvestingLenders(lender);
        } else {
            if (nonReinvestingLenders.length >= MAX_ALLOWED_NUM_NON_REINVESTING_LENDERS)
                revert Errors.nonReinvestYieldLenderCapacityReached();
            nonReinvestingLenders.push(lender);
        }
        depositRecord.reinvestYield = reinvestYield;
        depositRecords[lender] = depositRecord;
        emit ReinvestYieldConfigSet(lender, reinvestYield, msg.sender);
    }

    /// @inheritdoc IRedemptionHandler
    function executeRedemptionSummary(EpochRedemptionSummary memory summaryProcessed) external {
        _onlyEpochManager(msg.sender);

        if (summaryProcessed.totalSharesProcessed > 0) {
            epochRedemptionSummaries[summaryProcessed.epochId] = summaryProcessed;
            // Burn processed shares of LP tokens.
            ERC20Upgradeable._burn(address(this), summaryProcessed.totalSharesProcessed);
            // Withdraw underlying tokens from the reserve so that LPs can redeem.
            poolSafe.withdraw(address(this), summaryProcessed.totalAmountProcessed);
        }

        uint256 unprocessed = summaryProcessed.totalSharesRequested -
            summaryProcessed.totalSharesProcessed;

        if (unprocessed > 0) {
            // Move unprocessed redemption to next epoch
            EpochRedemptionSummary memory nextRedemptionSummary = EpochRedemptionSummary({
                epochId: summaryProcessed.epochId + 1,
                totalSharesRequested: uint96(unprocessed),
                totalSharesProcessed: 0,
                totalAmountProcessed: 0
            });
            epochRedemptionSummaries[nextRedemptionSummary.epochId] = nextRedemptionSummary;
        }

        emit EpochProcessed(
            summaryProcessed.epochId,
            summaryProcessed.totalSharesRequested,
            summaryProcessed.totalSharesProcessed,
            summaryProcessed.totalAmountProcessed
        );
    }

    /**
     * @notice Allows the pool owner and EA to make initial deposit before the pool goes live
     * @param assets The amount of underlyingTokens to be deposited
     */
    function makeInitialDeposit(uint256 assets) external returns (uint256 shares) {
        _onlyAuthorizedInitialDepositor(msg.sender);
        return _deposit(assets, msg.sender);
    }

    /**
     * @notice LP deposits to the pool to earn yield, and share losses
     *
     * @notice All deposits should be made by calling this function and
     * makeInitialDeposit() (for pool owner and EA's initial deposit) only.
     * Please do NOT directly transfer any digital assets to the contracts,
     * which will cause a permanent loss and we cannot help reverse transactions
     * or retrieve assets from the contracts.
     *
     * @param assets The number of underlyingTokens to be deposited
     * @param receiver The address to receive the minted tranche token
     * @return shares The number of tranche token to be minted
     */
    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        poolConfig.onlyProtocolAndPoolOn();
        if (assets == 0) revert Errors.zeroAmountProvided();
        if (receiver == address(0)) revert Errors.zeroAddressProvided();
        _onlyLender(msg.sender);
        _onlyLender(receiver);

        return _deposit(assets, receiver);
    }

    /**
     * @notice Records a new redemption request.
     * @param shares The number of shares the lender wants to redeem
     */
    function addRedemptionRequest(uint256 shares) external {
        if (shares == 0) revert Errors.zeroAmountProvided();
        poolConfig.onlyProtocolAndPoolOn();

        PoolSettings memory poolSettings = poolConfig.getPoolSettings();
        uint256 nextEpochStartTime = calendar.getStartDateOfNextPeriod(
            poolSettings.payPeriodDuration,
            block.timestamp
        );
        DepositRecord memory depositRecord = depositRecords[msg.sender];
        if (
            nextEpochStartTime <
            depositRecord.lastDepositTime +
                poolConfig.getLPConfig().withdrawalLockoutPeriodInDays *
                SECONDS_IN_A_DAY
        ) revert Errors.withdrawTooSoon();

        uint256 sharesBalance = ERC20Upgradeable.balanceOf(msg.sender);
        if (shares > sharesBalance) {
            revert Errors.insufficientSharesForRequest();
        }
        uint256 assetsAfterRedemption = convertToAssets(sharesBalance - shares);
        poolConfig.checkLiquidityRequirementForRedemption(
            msg.sender,
            address(this),
            assetsAfterRedemption
        );

        uint256 currentEpochId = epochManager.currentEpochId();
        EpochRedemptionSummary memory currRedemptionSummary = epochRedemptionSummaries[
            currentEpochId
        ];
        if (currRedemptionSummary.totalSharesRequested > 0) {
            // If the current epoch already has redemption requests, then add the new redemption request
            // to it.
            currRedemptionSummary.totalSharesRequested += uint96(shares);
        } else {
            // Otherwise, record the redemption request data in the global registry.
            currRedemptionSummary.epochId = uint64(currentEpochId);
            currRedemptionSummary.totalSharesRequested = uint96(shares);
        }
        epochRedemptionSummaries[currentEpochId] = currRedemptionSummary;

        LenderRedemptionRecord memory lenderRedemptionRecord = _getLatestLenderRedemptionRecord(
            msg.sender,
            currentEpochId
        );
        lenderRedemptionRecord.numSharesRequested += uint96(shares);
        uint256 principalRequested = (depositRecord.principal * shares) / sharesBalance;
        lenderRedemptionRecord.principalRequested += uint96(principalRequested);
        lenderRedemptionRecords[msg.sender] = lenderRedemptionRecord;
        depositRecord.principal = uint96(
            depositRecord.principal > principalRequested
                ? depositRecord.principal - principalRequested
                : 0
        );
        depositRecords[msg.sender] = depositRecord;

        ERC20Upgradeable._transfer(msg.sender, address(this), shares);

        emit RedemptionRequestAdded(msg.sender, shares, currentEpochId);
    }

    /**
     * @notice Cancels a previous redemption request of the specified number of shares.
     * @param shares The number of shares that the lender no longer wants to redeem
     */
    function cancelRedemptionRequest(uint256 shares) external {
        if (shares == 0) revert Errors.zeroAmountProvided();
        poolConfig.onlyProtocolAndPoolOn();

        uint256 currentEpochId = epochManager.currentEpochId();
        LenderRedemptionRecord memory lenderRedemptionRecord = _getLatestLenderRedemptionRecord(
            msg.sender,
            currentEpochId
        );

        if (lenderRedemptionRecord.numSharesRequested < shares) {
            revert Errors.insufficientSharesForRequest();
        }

        DepositRecord memory depositRecord = depositRecords[msg.sender];
        depositRecord.principal +=
            (lenderRedemptionRecord.principalRequested * uint96(shares)) /
            lenderRedemptionRecord.numSharesRequested;
        depositRecords[msg.sender] = depositRecord;

        uint96 newNumSharesRequested = lenderRedemptionRecord.numSharesRequested - uint96(shares);
        lenderRedemptionRecord.principalRequested =
            (lenderRedemptionRecord.principalRequested * newNumSharesRequested) /
            lenderRedemptionRecord.numSharesRequested;
        lenderRedemptionRecord.numSharesRequested = newNumSharesRequested;
        lenderRedemptionRecords[msg.sender] = lenderRedemptionRecord;

        EpochRedemptionSummary memory currRedemptionSummary = epochRedemptionSummaries[
            currentEpochId
        ];
        currRedemptionSummary.totalSharesRequested -= uint96(shares);
        epochRedemptionSummaries[currentEpochId] = currRedemptionSummary;

        ERC20Upgradeable._transfer(address(this), msg.sender, shares);

        emit RedemptionRequestRemoved(msg.sender, shares, currentEpochId);
    }

    /**
     * @notice Transfers the full redeemable amount to the lender
     */
    function disburse() external {
        poolConfig.onlyProtocolAndPoolOn();

        LenderRedemptionRecord memory record = _getLatestLenderRedemptionRecordFor(msg.sender);
        uint256 withdrawable = record.totalAmountProcessed - record.totalAmountWithdrawn;
        if (withdrawable > 0) {
            record.totalAmountWithdrawn += uint96(withdrawable);
            lenderRedemptionRecords[msg.sender] = record;
            underlyingToken.safeTransfer(msg.sender, withdrawable);
            emit LenderFundDisbursed(msg.sender, msg.sender, withdrawable);
        }
    }

    /**
     * @notice Processes yield of lenders. Pays out yield to lenders who are not reinvesting their yield.
     * @dev This function is expected to be called by a cron-like mechanism like autotask.
     */
    function processYieldForLenders() external {
        uint256 len = nonReinvestingLenders.length;

        uint256 price = convertToAssets(DEFAULT_DECIMALS_FACTOR);
        uint96[2] memory tranchesAssets = pool.currentTranchesAssets();
        for (uint256 i = 0; i < len; i++) {
            address lender = nonReinvestingLenders[i];
            uint256 shares = ERC20Upgradeable.balanceOf(lender);
            uint256 assets = (shares * price) / DEFAULT_DECIMALS_FACTOR;
            DepositRecord memory depositRecord = depositRecords[lender];
            if (assets > depositRecord.principal) {
                uint256 yield = assets - depositRecord.principal;
                // Round up the number of shares the lender has to burn in order to receive
                // the given amount of yield. The result favors the pool.
                shares = Math.ceilDiv(yield * DEFAULT_DECIMALS_FACTOR, price);
                ERC20Upgradeable._burn(lender, shares);
                poolSafe.withdraw(lender, yield);
                tranchesAssets[trancheIndex] -= uint96(yield);
                emit YieldPaidout(lender, yield, shares);
            }
        }
        poolSafe.resetUnprocessedProfit();
        pool.updateTranchesAssets(tranchesAssets);
    }

    /// @inheritdoc IRedemptionHandler
    function currentRedemptionSummary()
        external
        view
        override
        returns (EpochRedemptionSummary memory redemptionSummary)
    {
        uint256 epochId = epochManager.currentEpochId();
        redemptionSummary = epochRedemptionSummaries[epochId];
    }

    /**
     * @notice Returns the withdrawable assets value of the given account
     */
    function withdrawableAssets(address account) external view returns (uint256 assets) {
        LenderRedemptionRecord memory lenderRedemptionRecord = _getLatestLenderRedemptionRecordFor(
            account
        );
        assets =
            lenderRedemptionRecord.totalAmountProcessed -
            lenderRedemptionRecord.totalAmountWithdrawn;
    }

    /**
     * @notice Returns the number of shares previously requested for redemption that can be cancelled.
     * @param account The lender's account
     */
    function cancellableRedemptionShares(address account) external view returns (uint256 shares) {
        LenderRedemptionRecord memory lenderRedemptionRecord = _getLatestLenderRedemptionRecordFor(
            account
        );
        shares = lenderRedemptionRecord.numSharesRequested;
    }

    function convertToShares(uint256 assets) external view returns (uint256 shares) {
        shares = _convertToShares(assets, totalAssets());
    }

    function totalAssetsOf(address account) external view returns (uint256 assets) {
        return convertToAssets(ERC20Upgradeable.balanceOf(account));
    }

    function getNonReinvestingLendersLength() external view returns (uint256) {
        return nonReinvestingLenders.length;
    }

    /**
     * @notice Disables transfer function currently, need to consider how to support it later(lender permission,
     * yield payout, profit distribution, etc.) when integrating with DEXs.
     */
    function transfer(address, uint256) public virtual override returns (bool) {
        revert Errors.unsupportedFunction();
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function totalAssets() public view returns (uint256) {
        return pool.trancheTotalAssets(trancheIndex);
    }

    function totalSupply() public view override returns (uint256) {
        return ERC20Upgradeable.totalSupply();
    }

    function convertToAssets(uint256 shares) public view returns (uint256 assets) {
        uint256 tempTotalAssets = totalAssets();
        uint256 tempTotalSupply = ERC20Upgradeable.totalSupply();
        return tempTotalSupply == 0 ? shares : (shares * tempTotalAssets) / tempTotalSupply;
    }

    /**
     * @notice Gets address for underlyingToken, pool, poolSafe, and epochManager from poolConfig
     */
    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.underlyingToken();
        assert(addr != address(0));
        underlyingToken = IERC20(addr);
        _decimals = IERC20MetadataUpgradeable(addr).decimals();

        addr = _poolConfig.pool();
        assert(addr != address(0));
        pool = IPool(addr);

        addr = _poolConfig.poolSafe();
        assert(addr != address(0));
        poolSafe = IPoolSafe(addr);

        addr = _poolConfig.epochManager();
        assert(addr != address(0));
        epochManager = IEpochManager(addr);

        addr = _poolConfig.calendar();
        assert(addr != address(0));
        calendar = ICalendar(addr);
    }

    function _deposit(uint256 assets, address receiver) internal returns (uint256 shares) {
        PoolSettings memory poolSettings = poolConfig.getPoolSettings();
        if (assets < poolSettings.minDepositAmount) {
            revert Errors.depositAmountTooLow();
        }
        uint256 availableCap = pool.getTrancheAvailableCap(trancheIndex);
        if (assets > availableCap) {
            revert Errors.trancheLiquidityCapExceeded();
        }

        poolSafe.deposit(msg.sender, assets);
        uint96[2] memory tranches = pool.currentTranchesAssets();
        uint256 trancheAssets = tranches[trancheIndex];
        shares = _convertToShares(assets, trancheAssets);
        ERC20Upgradeable._mint(receiver, shares);
        DepositRecord memory depositRecord = depositRecords[receiver];
        depositRecord.principal += uint96(assets);
        depositRecord.lastDepositTime = uint64(block.timestamp);
        depositRecords[receiver] = depositRecord;

        tranches[trancheIndex] += uint96(assets);
        pool.updateTranchesAssets(tranches);

        emit LiquidityDeposited(msg.sender, receiver, assets, shares);
    }

    function _removeLenderFromNonReinvestingLenders(address lender) internal {
        uint256 len = nonReinvestingLenders.length;
        for (uint256 i = 0; i < len; i++) {
            if (nonReinvestingLenders[i] == lender) {
                if (i != len - 1) nonReinvestingLenders[i] = nonReinvestingLenders[len - 1];
                nonReinvestingLenders.pop();
                break;
            }
        }
    }

    function _convertToShares(
        uint256 _assets,
        uint256 _totalAssets
    ) internal view returns (uint256 shares) {
        uint256 supply = ERC20Upgradeable.totalSupply();

        return supply == 0 ? _assets : (_assets * supply) / _totalAssets;
    }

    function _getLatestLenderRedemptionRecordFor(
        address account
    ) internal view returns (LenderRedemptionRecord memory lenderRedemptionRecord) {
        uint256 currentEpochId = epochManager.currentEpochId();
        lenderRedemptionRecord = _getLatestLenderRedemptionRecord(account, currentEpochId);
    }

    /**
     * @notice Brings the redemption record for a lender up-to-date.
     * @dev Prior to invoking this function, the lender's redemption record may be outdated, not accurately reflecting
     * the amount of withdrawable funds. This is due to the potential passage of additional epochs and the
     * processing of further redemption requests since the lender's last update. This function addresses this
     * by iterating through all epochs executed since the last update, ensuring the redemption record is current
     * and accurate.
     * @return lenderRedemptionRecord The lender's updated processed redemption request record.
     */
    function _getLatestLenderRedemptionRecord(
        address account,
        uint256 currentEpochId
    ) internal view returns (LenderRedemptionRecord memory lenderRedemptionRecord) {
        lenderRedemptionRecord = lenderRedemptionRecords[account];
        uint256 totalShares = lenderRedemptionRecord.numSharesRequested;
        if (totalShares > 0 && lenderRedemptionRecord.nextEpochIdToProcess < currentEpochId) {
            uint256 remainingShares = totalShares;
            for (
                uint256 epochId = lenderRedemptionRecord.nextEpochIdToProcess;
                epochId < currentEpochId && remainingShares > 0;
                ++epochId
            ) {
                EpochRedemptionSummary memory summary = epochRedemptionSummaries[epochId];
                if (summary.totalSharesProcessed > 0) {
                    lenderRedemptionRecord.totalAmountProcessed += uint96(
                        (remainingShares * summary.totalAmountProcessed) /
                            summary.totalSharesRequested
                    );
                    // Round up the number of shares the lender burned for the redemption requests that
                    // have been processed, so that the remaining number of shares is rounded down.
                    // The result favors the pool.
                    remainingShares -= Math.ceilDiv(
                        remainingShares * summary.totalSharesProcessed,
                        summary.totalSharesRequested
                    );
                }
            }
            lenderRedemptionRecord.numSharesRequested = uint96(remainingShares);
            if (remainingShares < totalShares) {
                // Some shares are processed, so the principal requested is reduced proportionally.
                lenderRedemptionRecord.principalRequested = uint96(
                    (remainingShares * lenderRedemptionRecord.principalRequested) / totalShares
                );
            }
        }
        lenderRedemptionRecord.nextEpochIdToProcess = uint64(currentEpochId);
    }

    function _onlyEpochManager(address account) internal view {
        if (account != address(epochManager)) revert Errors.notAuthorizedCaller();
    }

    function _onlyAuthorizedInitialDepositor(address account) internal view {
        if (account != poolConfig.poolOwnerTreasury() && account != poolConfig.evaluationAgent())
            revert Errors.notAuthorizedCaller();
    }

    function _onlyLender(address account) internal view {
        if (!hasRole(LENDER_ROLE, account)) revert Errors.permissionDeniedNotLender();
    }
}
