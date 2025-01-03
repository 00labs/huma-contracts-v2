// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {Errors} from "../common/Errors.sol";
import {LPConfig, PoolConfig, PoolSettings} from "../common/PoolConfig.sol";
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

/**
 * @title TrancheVault
 * @notice TrancheVault is the vault for a tranche. It is the primary interface for lenders
 * to participate in a tranche by depositing into or withdrawing from the tranche.
 * @dev This contract is upgradable.
 */
contract TrancheVault is
    AccessControlUpgradeable,
    ERC20Upgradeable,
    PoolConfigCache,
    TrancheVaultStorage,
    IRedemptionHandler
{
    using SafeERC20 for IERC20;

    bytes32 public constant LENDER_ROLE = keccak256("LENDER");

    /**
     * @notice The max number of lenders who can get yield payout at the end of each period.
     * The reason for this cap is that we would like to process yield payout in one block.
     * The cap is estimated based on the block gas limit.
     * Please note there is no cap on the number of lenders for a tranche. As yield comes in,
     * the tranche token price goes up, that is how the investors who are not paid each period
     * gets their return. For those who are getting paid each period, their number of shares
     * goes down when a yield payout happens.
     */
    uint256 private constant _MAX_ALLOWED_NUM_NON_REINVESTING_LENDERS = 100;

    /**
     * @notice An epoch has been processed.
     * @param epochId The epoch ID.
     * @param sharesRequested The number of tranche shares that were requested for redemption.
     * @param sharesProcessed The number of tranche shares that have been redeemed.
     * @param amountProcessed The amount of the underlying pool asset token redeemed in this epoch.
     */
    event EpochProcessed(
        uint256 indexed epochId,
        uint256 sharesRequested,
        uint256 sharesProcessed,
        uint256 amountProcessed
    );

    /**
     * @notice A lender has been added.
     * @param account The address of the lender.
     * @param reinvestYield A flag indicating whether the lender is reinvesting or not.
     */
    event LenderAdded(address indexed account, bool reinvestYield);

    /**
     * @notice A lender has been removed.
     * @param account The address of the lender.
     */
    event LenderRemoved(address indexed account);

    /**
     * @notice A deposit has been made to the tranche.
     * @param sender The address that made the deposit.
     * @param assets The amount measured in the underlying asset.
     * @param shares The number of shares minted for this deposit.
     */
    event LiquidityDeposited(address indexed sender, uint256 assets, uint256 shares);

    /**
     * @notice A disbursement to the lender for a processed redemption.
     * @param account The account whose shares have been redeemed.
     * @param amountDisbursed The amount of the disbursement.
     */
    event LenderFundDisbursed(address indexed account, uint256 amountDisbursed);

    /**
     * @notice A lender has withdrawn all their assets after pool closure.
     * @param account The lender who has withdrawn.
     * @param numShares The number of shares burned.
     * @param assets The amount that was withdrawn.
     */
    event LenderFundWithdrawn(address indexed account, uint256 numShares, uint256 assets);

    /**
     * @notice A redemption request has been added.
     * @param account The account whose shares are requested for redemption.
     * @param requester The account that requested redemption.
     * @param shares The number of shares to be redeemed.
     * @param epochId The epoch ID.
     */
    event RedemptionRequestAdded(
        address indexed account,
        address indexed requester,
        uint256 shares,
        uint256 epochId
    );

    /**
     * @notice A redemption request has been canceled.
     * @param account The account whose request to be canceled.
     * @param shares The number of shares to be included in the cancellation.
     * @param epochId The epoch ID.
     */
    event RedemptionRequestRemoved(address indexed account, uint256 shares, uint256 epochId);

    /**
     * @notice Yield has been paid to the investor.
     * @param account The account who has received the yield distribution.
     * @param yields The amount of yield distributed.
     * @param shares The number of shares burned for this distribution.
     */
    event YieldPaidOut(address indexed account, uint256 yields, uint256 shares);

    /**
     * @notice Yield payout to the investor has failed.
     * @param account The account who should have received the yield distribution.
     * @param yields The amount of yield that should have been distributed.
     * @param shares The number of shares that should have been burned for this distribution.
     * @param reason The reason why the payout failed.
     */
    event YieldPayoutFailed(
        address indexed account,
        uint256 yields,
        uint256 shares,
        string reason
    );

    /**
     * @notice Yield has been reinvested into the tranche.
     * @param account The account whose yield has been reinvested.
     * @param yields The yield amount reinvested.
     */
    event YieldReinvested(address indexed account, uint256 yields);

    /**
     * @notice The yield reinvestment setting has been updated.
     * @param account The account whose setting has been updated.
     * @param reinvestYield A flag indicating whether the lender is reinvesting or not.
     * @param by The address who has made the change.
     */
    event ReinvestYieldConfigSet(address indexed account, bool reinvestYield, address by);

    /**
     * @notice Initializes the tranche.
     * @param name The name of the tranche token.
     * @param symbol The symbol of the tranche token.
     * @param poolConfig_ PoolConfig that has various settings of the pool.
     * @param seniorTrancheOrJuniorTranche Indicator of junior or senior tranche. Since only
     * junior and senior tranches are supported right now, this param needs to be 0 or 1.
     * @custom:access Initialize can be called when the contract is initialized.
     */
    function initialize(
        string memory name,
        string memory symbol,
        PoolConfig poolConfig_,
        uint8 seniorTrancheOrJuniorTranche
    ) external initializer {
        __ERC20_init(name, symbol);
        __AccessControl_init();
        __UUPSUpgradeable_init();
        _initialize(poolConfig_);

        if (seniorTrancheOrJuniorTranche > 1) revert Errors.InvalidTrancheIndex();
        trancheIndex = seniorTrancheOrJuniorTranche;
    }

    /**
     * @notice Adds an approved lender.
     * @notice Lenders need to pass compliance requirements. Pool operator will administer off-chain
     * to make sure potential lenders meet the requirements. Afterwards, the pool operator will
     * call this function to mark a lender as approved.
     * @param lender The lender address.
     * @param reinvestYield Whether the lender will reinvest yield or receives yield payout. Please
     * note there is a 100 cap on the number of lenders who receive yield payout. If this flag is
     * false and that cap has returned, the approval will fail. The approver has to resubmit with
     * a true flag.
     * @custom:access Only pool operators can access to approve lenders.
     */
    function addApprovedLender(address lender, bool reinvestYield) external {
        poolConfig.onlyPoolOperator(msg.sender);
        if (lender == address(0)) revert Errors.ZeroAddressProvided();
        if (hasRole(LENDER_ROLE, lender)) revert Errors.AlreadyALender();

        _grantRole(LENDER_ROLE, lender);
        _setDepositRecord(
            lender,
            DepositRecord({principal: 0, reinvestYield: reinvestYield, lastDepositTime: 0})
        );
        if (!reinvestYield) {
            if (nonReinvestingLenders.length >= _MAX_ALLOWED_NUM_NON_REINVESTING_LENDERS)
                revert Errors.NonReinvestYieldLenderCapacityReached();
            nonReinvestingLenders.push(lender);
        }

        emit LenderAdded(lender, reinvestYield);
    }

    /**
     * @notice Removes a lender. This prevents the lender from making more deposits.
     * The capital that the lender has contributed can continue to work as normal.
     * @notice If a lender has received yield payout before, when they are removed as a lender,
     * they will be converted to auto reinvesting.
     * @dev It is intentional not to delete depositRecord for the lender so that they do not
     * lose existing investment. They can request redemption post removal as a lender.
     * @dev Because of lockout period and pool liquidity constraints, we cannot automatically
     * disburse the investment by this lender.
     * @param lender The lender address.
     * @custom:access Only pool operators can access to remove lenders.
     */
    function removeApprovedLender(address lender) external {
        poolConfig.onlyPoolOperator(msg.sender);
        if (lender == address(0)) revert Errors.ZeroAddressProvided();
        _revokeRole(LENDER_ROLE, lender);
        if (!_getDepositRecord(lender).reinvestYield) {
            _removeLenderFromNonReinvestingLenders(lender);
        }

        emit LenderRemoved(lender);
    }

    /**
     * @notice Sets if a lender is going to reinvest the yield they receive.
     * @custom:access Only pool operators can call this function.
     */
    function setReinvestYield(address lender, bool reinvestYield) external {
        poolConfig.onlyPoolOperator(msg.sender);
        if (!hasRole(LENDER_ROLE, lender)) revert Errors.LenderRequired();

        DepositRecord memory depositRecord = _getDepositRecord(lender);
        if (depositRecord.reinvestYield == reinvestYield)
            revert Errors.ReinvestYieldOptionAlreadySet();
        if (!depositRecord.reinvestYield && reinvestYield) {
            _removeLenderFromNonReinvestingLenders(lender);
        } else {
            if (nonReinvestingLenders.length >= _MAX_ALLOWED_NUM_NON_REINVESTING_LENDERS)
                revert Errors.NonReinvestYieldLenderCapacityReached();
            nonReinvestingLenders.push(lender);
        }
        depositRecord.reinvestYield = reinvestYield;
        _setDepositRecord(lender, depositRecord);
        emit ReinvestYieldConfigSet(lender, reinvestYield, msg.sender);
    }

    /// @inheritdoc IRedemptionHandler
    function executeRedemptionSummary(EpochRedemptionSummary memory summaryProcessed) external {
        if (msg.sender != address(epochManager)) revert Errors.AuthorizedContractCallerRequired();

        if (summaryProcessed.totalSharesProcessed > 0) {
            _setEpochRedemptionSummary(summaryProcessed);
            // Burn processed shares of LP tokens.
            ERC20Upgradeable._burn(address(this), summaryProcessed.totalSharesProcessed);
            // Withdraw underlying tokens from the reserve so that LPs can redeem.
            poolSafe.withdraw(address(this), summaryProcessed.totalAmountProcessed);
        }

        uint256 unprocessed = summaryProcessed.totalSharesRequested -
            summaryProcessed.totalSharesProcessed;

        if (unprocessed > 0) {
            // Move unprocessed redemption to next epoch.
            EpochRedemptionSummary memory nextRedemptionSummary = EpochRedemptionSummary({
                epochId: summaryProcessed.epochId + 1,
                totalSharesRequested: uint96(unprocessed),
                totalSharesProcessed: 0,
                totalAmountProcessed: 0
            });
            _setEpochRedemptionSummary(nextRedemptionSummary);
        }

        emit EpochProcessed(
            summaryProcessed.epochId,
            summaryProcessed.totalSharesRequested,
            summaryProcessed.totalSharesProcessed,
            summaryProcessed.totalAmountProcessed
        );
    }

    /**
     * @notice Allows the pool owner and EA to make initial deposit before the pool goes live.
     * @param assets The amount of underlyingTokens to be deposited.
     * @return shares The number of tranche token to be minted.
     */
    function makeInitialDeposit(uint256 assets) external returns (uint256 shares) {
        _onlyAuthorizedInitialDepositor(msg.sender);
        return _deposit(assets);
    }

    /**
     * @notice LP deposits to the pool to earn yield and share losses.
     * @notice All deposits should be made by calling this function and
     * makeInitialDeposit() (for pool owner and EA's initial deposit) only.
     * Please do NOT directly transfer any digital assets to the contracts,
     * which will cause a permanent loss and we cannot help reverse transactions
     * or retrieve assets from the contracts.
     * @param assets The number of underlyingTokens to be deposited.
     * @return shares The number of tranche token to be minted.
     * @custom:access Any approved lender can call to deposit.
     */
    function deposit(uint256 assets) external returns (uint256 shares) {
        poolConfig.onlyProtocolAndPoolOn();
        if (assets == 0) revert Errors.ZeroAmountProvided();
        _onlyLender(msg.sender);

        return _deposit(assets);
    }

    /**
     * @notice Records a new redemption request.
     * @notice If `autoRedemptionAfterLockup` is true, then allow Sentinel service account to request redemption
     * on behalf of the lender as required by the SPV of certain pools.
     * @param lender The account whose shares are requested for redemption.
     * @param shares The number of shares the lender wants to redeem.
     * @custom:access Only the lender and the Sentinel service account can request redemption.
     */
    function addRedemptionRequest(address lender, uint256 shares) external {
        if (shares == 0) revert Errors.ZeroAmountProvided();
        LPConfig memory lpConfig = poolConfig.getLPConfig();
        if (msg.sender != lender) {
            if (!lpConfig.autoRedemptionAfterLockup) {
                // If `autoRedemptionAfterLockup` is not enabled, then only the lender can request redemption.
                revert Errors.LenderRequired();
            }
            // Otherwise, only the Sentinel service account can request redemption on behalf of the lender.
            if (msg.sender != poolConfig.humaConfig().sentinelServiceAccount()) {
                revert Errors.SentinelServiceAccountRequired();
            }
        }
        poolConfig.onlyProtocolAndPoolOn();

        PoolSettings memory poolSettings = poolConfig.getPoolSettings();
        uint256 nextEpochStartTime = calendar.getStartDateOfNextPeriod(
            poolSettings.payPeriodDuration,
            block.timestamp
        );

        // Check against withdrawal lockup period.
        DepositRecord memory depositRecord = _getDepositRecord(lender);
        if (
            nextEpochStartTime <
            depositRecord.lastDepositTime +
                lpConfig.withdrawalLockoutPeriodInDays *
                SECONDS_IN_A_DAY
        ) revert Errors.WithdrawTooEarly();

        uint256 sharesBalance = ERC20Upgradeable.balanceOf(lender);
        if (shares > sharesBalance) {
            revert Errors.InsufficientSharesForRequest();
        }
        uint256 assetsAfterRedemption = convertToAssets(sharesBalance - shares);
        poolConfig.checkLiquidityRequirementForRedemption(
            lender,
            address(this),
            assetsAfterRedemption
        );

        uint256 currentEpochId = epochManager.currentEpochId();
        EpochRedemptionSummary memory currRedemptionSummary = _getEpochRedemptionSummary(
            currentEpochId
        );
        if (currRedemptionSummary.totalSharesRequested > 0) {
            // If the current epoch already has redemption requests, then add the new redemption request
            // to it.
            currRedemptionSummary.totalSharesRequested += uint96(shares);
        } else {
            // Otherwise, record the redemption request data in the global registry.
            currRedemptionSummary.epochId = uint64(currentEpochId);
            currRedemptionSummary.totalSharesRequested = uint96(shares);
        }
        _setEpochRedemptionSummary(currRedemptionSummary);

        LenderRedemptionRecord memory lenderRedemptionRecord = _getLatestLenderRedemptionRecord(
            lender,
            currentEpochId
        );
        lenderRedemptionRecord.numSharesRequested += uint96(shares);
        uint256 principalRequested = (depositRecord.principal * shares) / sharesBalance;
        lenderRedemptionRecord.principalRequested += uint96(principalRequested);
        _setLenderRedemptionRecord(lender, lenderRedemptionRecord);
        depositRecord.principal -= uint96(principalRequested);
        _setDepositRecord(lender, depositRecord);

        ERC20Upgradeable._transfer(lender, address(this), shares);

        emit RedemptionRequestAdded(lender, msg.sender, shares, currentEpochId);
    }

    /**
     * @notice Cancels a redemption request submitted before.
     * @notice If `autoRedemptionAfterLockup` is true, then cancellation is disabled to enforce
     * redemption requests processing.
     * @param shares The number of shares in the redemption request to be canceled.
     * @custom:access Only the lender can submit for themselves.
     */
    function cancelRedemptionRequest(uint256 shares) external {
        LPConfig memory lpConfig = poolConfig.getLPConfig();
        if (lpConfig.autoRedemptionAfterLockup) revert Errors.RedemptionCancellationDisabled();
        if (shares == 0) revert Errors.ZeroAmountProvided();
        poolConfig.onlyProtocolAndPoolOn();

        uint256 currentEpochId = epochManager.currentEpochId();
        LenderRedemptionRecord memory lenderRedemptionRecord = _getLatestLenderRedemptionRecord(
            msg.sender,
            currentEpochId
        );

        if (lenderRedemptionRecord.numSharesRequested < shares) {
            revert Errors.InsufficientSharesForRequest();
        }

        DepositRecord memory depositRecord = _getDepositRecord(msg.sender);
        depositRecord.principal +=
            (lenderRedemptionRecord.principalRequested * uint96(shares)) /
            lenderRedemptionRecord.numSharesRequested;
        _setDepositRecord(msg.sender, depositRecord);

        uint96 newNumSharesRequested = lenderRedemptionRecord.numSharesRequested - uint96(shares);
        lenderRedemptionRecord.principalRequested =
            (lenderRedemptionRecord.principalRequested * newNumSharesRequested) /
            lenderRedemptionRecord.numSharesRequested;
        lenderRedemptionRecord.numSharesRequested = newNumSharesRequested;
        _setLenderRedemptionRecord(msg.sender, lenderRedemptionRecord);

        EpochRedemptionSummary memory currRedemptionSummary = _getEpochRedemptionSummary(
            currentEpochId
        );
        currRedemptionSummary.totalSharesRequested -= uint96(shares);
        _setEpochRedemptionSummary(currRedemptionSummary);

        ERC20Upgradeable._transfer(address(this), msg.sender, shares);

        emit RedemptionRequestRemoved(msg.sender, shares, currentEpochId);
    }

    /**
     * @notice Transfers all the amount that has been redeemed but not yet disbursed to the lender.
     * @custom:access Only the lender can submit for themselves.
     */
    function disburse() external {
        poolConfig.onlyProtocolAndPoolOn();

        _disburse();
    }

    /**
     * @notice Allows the lender to withdraw all their assets after the pool has been permanently closed.
     * @custom:access Only the lender can withdraw for themselves.
     */
    function withdrawAfterPoolClosure() external {
        if (!pool.isPoolClosed()) revert Errors.PoolIsNotClosed();

        // First, disburse all the funds from the lender's previously processed redemption requests.
        _disburse();

        // Then, let the lender withdraw all their remaining assets in the pool.
        uint256 numShares = ERC20Upgradeable.balanceOf(msg.sender);
        if (numShares > 0) {
            uint256 assets = convertToAssets(numShares);

            // Update tranches assets to reflect the reduction in total assets.
            uint96[2] memory tranchesAssets = pool.currentTranchesAssets();
            tranchesAssets[trancheIndex] -= uint96(assets);
            pool.updateTranchesAssets(tranchesAssets);

            // Set the lender's deposited principal to 0.
            DepositRecord memory depositRecord = _getDepositRecord(msg.sender);
            depositRecord.principal = 0;
            _setDepositRecord(msg.sender, depositRecord);

            // Burn the LP tokens and transfer assets to the lender.
            ERC20Upgradeable._burn(msg.sender, numShares);
            poolSafe.withdraw(msg.sender, assets);
            emit LenderFundWithdrawn(msg.sender, numShares, assets);
        }
    }

    /**
     * @notice Processes yield payout to all the lenders who are set to receive their yield
     * distribution at the end of each period. Their tokens will be burned for the payout and
     * their investment in the pool measured by dollar amount remains unchanged.
     * @custom:access Anyone can call to trigger the processing. In reality, we expect
     * a cron-like mechanism like autotask to trigger it.
     */
    function processYieldForLenders() external {
        poolConfig.onlyProtocolAndPoolOn();

        uint256 priceWithDecimals = convertToAssets(DEFAULT_DECIMALS_FACTOR);
        uint256 len = nonReinvestingLenders.length;
        uint96[2] memory tranchesAssets = pool.currentTranchesAssets();
        for (uint256 i = 0; i < len; i++) {
            address lender = nonReinvestingLenders[i];
            uint256 shares = ERC20Upgradeable.balanceOf(lender);
            uint256 assetsWithDecimals = shares * priceWithDecimals;
            DepositRecord memory depositRecord = _getDepositRecord(lender);
            uint256 principalWithDecimals = depositRecord.principal * DEFAULT_DECIMALS_FACTOR;
            if (assetsWithDecimals > principalWithDecimals) {
                uint256 yieldWithDecimals = assetsWithDecimals - principalWithDecimals;
                uint256 yield = yieldWithDecimals / DEFAULT_DECIMALS_FACTOR;
                // Round up the number of shares the lender has to burn in order to receive
                // the given amount of yield. Round-up applies the favor-the-pool principle.
                shares = Math.ceilDiv(yieldWithDecimals, priceWithDecimals);
                // The underlying asset of the pool may incorporate a blocklist feature that prevents the lender
                // from receiving yield if they are subject to sanctions, and consequently the `transfer` call
                // would fail for the lender. We bypass the yield of this lender so that other lenders can
                // still get their yield paid out as normal.
                try poolSafe.withdraw(lender, yield) {
                    tranchesAssets[trancheIndex] -= uint96(yield);
                    ERC20Upgradeable._burn(lender, shares);
                    emit YieldPaidOut(lender, yield, shares);
                } catch Error(string memory reason) {
                    emit YieldPayoutFailed(lender, yield, shares, reason);
                }
            }
        }
        poolSafe.resetUnprocessedProfit();
        pool.updateTranchesAssets(tranchesAssets);
    }

    /// @inheritdoc IRedemptionHandler
    function epochRedemptionSummary(
        uint256 epochId
    ) external view override returns (EpochRedemptionSummary memory redemptionSummary) {
        redemptionSummary = _getEpochRedemptionSummary(epochId);
    }

    /**
     * @notice Returns the amount of withdrawable value of the given account.
     * @param account The account whose withdrawable assets should be calculated.
     * @param assets The withdrawable amount.
     */
    function withdrawableAssets(address account) external view returns (uint256 assets) {
        LenderRedemptionRecord memory lenderRedemptionRecord = _getLatestLenderRedemptionRecordFor(
            account
        );
        assets =
            lenderRedemptionRecord.totalAmountProcessed -
            lenderRedemptionRecord.totalAmountWithdrawn;

        if (pool.isPoolClosed()) {
            // If the pool is closed, all the lender's assets are withdrawable.
            assets += totalAssetsOf(account);
        }
    }

    /**
     * @notice Returns the number of shares previously requested for redemption that can be cancelled.
     * @param account The lender's account.
     */
    function cancellableRedemptionShares(address account) external view returns (uint256 shares) {
        shares = _getLatestLenderRedemptionRecordFor(account).numSharesRequested;
    }

    function convertToShares(uint256 assets) external view returns (uint256 shares) {
        shares = _convertToShares(assets, totalAssets());
    }

    /// Gets the list of lenders who are receiving yield distribution in each period.
    function getNonReinvestingLendersLength() external view returns (uint256) {
        return nonReinvestingLenders.length;
    }

    /**
     * @notice Disables the transfer functionality.
     */
    function transfer(address, uint256) public virtual override returns (bool) {
        revert Errors.UnsupportedFunction();
    }

    /**
     * @notice Disables the transfer functionality.
     */
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) public virtual override returns (bool) {
        revert Errors.UnsupportedFunction();
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function totalAssets() public view returns (uint256) {
        return pool.trancheTotalAssets(trancheIndex);
    }

    function totalAssetsOf(address account) public view returns (uint256 assets) {
        return convertToAssets(ERC20Upgradeable.balanceOf(account));
    }

    function convertToAssets(uint256 shares) public view returns (uint256 assets) {
        uint256 tempTotalAssets = totalAssets();
        uint256 tempTotalSupply = ERC20Upgradeable.totalSupply();
        return tempTotalSupply == 0 ? shares : (shares * tempTotalAssets) / tempTotalSupply;
    }

    /// Utility function to cache the dependent contract addresses.
    function _updatePoolConfigData(PoolConfig poolConfig_) internal virtual override {
        address addr = poolConfig_.underlyingToken();
        assert(addr != address(0));
        underlyingToken = IERC20(addr);
        _decimals = IERC20MetadataUpgradeable(addr).decimals();

        addr = poolConfig_.pool();
        assert(addr != address(0));
        pool = IPool(addr);

        addr = poolConfig_.poolSafe();
        assert(addr != address(0));
        poolSafe = IPoolSafe(addr);

        addr = poolConfig_.epochManager();
        assert(addr != address(0));
        epochManager = IEpochManager(addr);

        addr = poolConfig_.calendar();
        assert(addr != address(0));
        calendar = ICalendar(addr);
    }

    /**
     * @notice Internal function to support LP deposit into the tranche.
     * @param assets The number of underlyingTokens to be deposited.
     * @return shares The number of tranche token to be minted.
     */
    function _deposit(uint256 assets) internal returns (uint256 shares) {
        PoolSettings memory poolSettings = poolConfig.getPoolSettings();
        if (assets < poolSettings.minDepositAmount) {
            revert Errors.DepositAmountTooLow();
        }
        uint256 availableCap = pool.getTrancheAvailableCap(trancheIndex);
        if (assets > availableCap) {
            revert Errors.TrancheLiquidityCapExceeded();
        }

        poolSafe.deposit(msg.sender, assets);
        uint96[2] memory tranches = pool.currentTranchesAssets();
        uint256 trancheAssets = tranches[trancheIndex];
        shares = _convertToShares(assets, trancheAssets);

        if (shares == 0) {
            // Disallows 0 shares to be minted. This can be caused by rounding errors or the tranche
            // losing all of its assets after default.
            revert Errors.ZeroSharesMinted();
        }
        ERC20Upgradeable._mint(msg.sender, shares);
        DepositRecord memory depositRecord = _getDepositRecord(msg.sender);
        depositRecord.principal += uint96(assets);
        depositRecord.lastDepositTime = uint64(block.timestamp);
        _setDepositRecord(msg.sender, depositRecord);

        tranches[trancheIndex] += uint96(assets);
        pool.updateTranchesAssets(tranches);

        emit LiquidityDeposited(msg.sender, assets, shares);
    }

    /**
     * @notice Internal function to support the disbursement of funds from processed redemption requests.
     */
    function _disburse() internal {
        LenderRedemptionRecord memory record = _getLatestLenderRedemptionRecordFor(msg.sender);
        uint256 withdrawable = record.totalAmountProcessed - record.totalAmountWithdrawn;
        if (withdrawable > 0) {
            record.totalAmountWithdrawn += uint96(withdrawable);
            _setLenderRedemptionRecord(msg.sender, record);
            underlyingToken.safeTransfer(msg.sender, withdrawable);
            emit LenderFundDisbursed(msg.sender, withdrawable);
        }
    }

    /**
     * @notice Internal function to remove a lender from the list of lenders who receive yield
     * distribution in each period.
     * @param lender The lender to be removed.
     * @dev The function scans through the list. Since the list is capped at 100, and the caller
     * is a pool operator, gas fee is not much of an issue.
     */
    function _removeLenderFromNonReinvestingLenders(address lender) internal {
        uint256 len = nonReinvestingLenders.length;
        for (uint256 i = 0; i < len; i++) {
            if (nonReinvestingLenders[i] == lender) {
                // Copies the last one on the list into the slot to be removed, and remove the last one
                // from the list.
                if (i != len - 1) nonReinvestingLenders[i] = nonReinvestingLenders[len - 1];
                nonReinvestingLenders.pop();
                break;
            }
        }
    }

    /// Utility set function to reduce contract size.
    function _setLenderRedemptionRecord(
        address account,
        LenderRedemptionRecord memory record
    ) internal {
        lenderRedemptionRecords[account] = record;
    }

    /// Utility set function to reduce contract size.
    function _setEpochRedemptionSummary(EpochRedemptionSummary memory summary) internal {
        epochRedemptionSummaries[summary.epochId] = summary;
    }

    /// Utility set function to reduce contract size.
    function _setDepositRecord(address account, DepositRecord memory record) internal {
        depositRecords[account] = record;
    }

    /**
     * @notice Converts assets to shares of this tranche token.
     * @param assets The amount of the underlying assets.
     * @param totalAssets_ The total amount of the underlying assets in the tranche.
     * @return shares The corresponding number of shares for the given assets.
     */
    function _convertToShares(
        uint256 assets,
        uint256 totalAssets_
    ) internal view returns (uint256 shares) {
        uint256 supply = ERC20Upgradeable.totalSupply();
        if (supply != 0 && totalAssets_ == 0) return 0;
        return supply == 0 ? assets : (assets * supply) / totalAssets_;
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
     * @param account The address for which the latest RedemptionRecord should be computed.
     * @param currentEpochId The ID of the current epoch.
     * @return lenderRedemptionRecord The lender's updated processed redemption request record.
     */
    function _getLatestLenderRedemptionRecord(
        address account,
        uint256 currentEpochId
    ) internal view returns (LenderRedemptionRecord memory lenderRedemptionRecord) {
        lenderRedemptionRecord = lenderRedemptionRecords[account];
        uint256 totalShares = lenderRedemptionRecord.numSharesRequested;
        // The inclusion of "=" in the second condition is crucial. When the pool is active,
        // redemption requests are processed at the closure of an epoch, and a new epoch is
        // created and becomes the current epoch. As a result, there is no processed
        // redemption requests in the current epoch. However, once the pool is closed, the pool owner will
        // process outstanding redemption requests within the final epoch, without creating a new one.
        // Consequently, the epoch ID will remain unchanged. This means that the current epoch may
        // include processed requests, and therefore, it is essential to take the current epoch into account.
        if (totalShares > 0 && lenderRedemptionRecord.nextEpochIdToProcess <= currentEpochId) {
            uint256 remainingShares = totalShares;
            for (
                uint256 epochId = lenderRedemptionRecord.nextEpochIdToProcess;
                epochId <= currentEpochId && remainingShares > 0;
                ++epochId
            ) {
                EpochRedemptionSummary memory summary = _getEpochRedemptionSummary(epochId);
                if (summary.totalSharesProcessed > 0) {
                    lenderRedemptionRecord.totalAmountProcessed += uint96(
                        (remainingShares * summary.totalAmountProcessed) /
                            summary.totalSharesRequested
                    );
                    // Round up the number of shares the lender burned for the redemption requests that
                    // have been processed, so that the remaining number of shares is rounded down.
                    // This applies the favor-the-pool principle for roundings.
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

    function _getEpochRedemptionSummary(
        uint256 epochId
    ) internal view returns (EpochRedemptionSummary memory) {
        return epochRedemptionSummaries[epochId];
    }

    function _getDepositRecord(address account) internal view returns (DepositRecord memory) {
        return depositRecords[account];
    }

    function _onlyAuthorizedInitialDepositor(address account) internal view {
        if (account != poolConfig.poolOwnerTreasury() && account != poolConfig.evaluationAgent())
            revert Errors.AuthorizedContractCallerRequired();
    }

    function _onlyLender(address account) internal view {
        if (!hasRole(LENDER_ROLE, account)) revert Errors.LenderRequired();
    }
}
