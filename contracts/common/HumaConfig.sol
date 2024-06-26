// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";
import {Errors} from "./Errors.sol";

/**
 * @notice HumaConfig maintains all the global configurations supported by the Huma protocol.
 */
contract HumaConfig is Ownable, Pausable {
    /// The default treasury fee in bps.
    uint16 private constant _DEFAULT_TREASURY_FEE = 500; // 5%

    /// The treasury fee upper bound in bps.
    uint16 private constant _TREASURY_FEE_UPPER_BOUND = 5000; // 50%

    /// % of platform income that will be reserved in the protocol, measured in basis points.
    uint16 public protocolFeeInBps;

    /// Address of the Huma protocol treasury.
    address public humaTreasury;

    /// Service account for Huma's Sentinel service.
    address public sentinelServiceAccount;

    /// Pausers can pause the pool.
    mapping(address => bool) public pausers;

    /// List of assets supported by the protocol for investing and borrowing.
    mapping(address => bool) public validLiquidityAssets;

    /**
     * @notice The treasury address for Huma protocol has changed.
     * @param newTreasuryAddress The address of the new Huma treasury.
     */
    event HumaTreasuryChanged(address indexed newTreasuryAddress, address by);

    /**
     * @notice New underlying asset supported by the protocol is added.
     * @param asset The address of the liquidity asset being added.
     * @param by The address that triggered the addition.
     */
    event LiquidityAssetAdded(address asset, address by);

    /**
     * @notice Remove the asset that is no longer supported by the protocol.
     * @param asset The address of the liquidity asset being removed.
     * @param by The address that triggered the removal.
     */
    event LiquidityAssetRemoved(address asset, address by);

    /**
     * @notice A pauser has been added. A pauser is someone who can pause the protocol.
     * @param pauser The address of the pauser being added.
     * @param by The address that triggered the addition.
     */
    event PauserAdded(address indexed pauser, address by);

    /**
     * @notice A pauser has been removed.
     * @param pauser The address of the pauser being removed.
     * @param by The address that triggered the removal.
     */
    event PauserRemoved(address indexed pauser, address by);

    /**
     * @notice Service account for the Sentinel Service has been changed.
     * @param sentinelService The address of the new Sentinel Service.
     */
    event SentinelServiceAccountChanged(address sentinelService, address by);

    /**
     * @notice The Huma protocol has been initialized.
     * @param by The address that initialized the protocol.
     */
    event ProtocolInitialized(address by);

    /**
     * @notice The treasury fee has been changed.
     * @param oldFee The old treasury fee.
     * @param newFee The new treasury fee.
     */
    event TreasuryFeeChanged(uint256 oldFee, uint256 newFee, address by);

    /// Makes sure the msg.sender is one of the pausers.
    modifier onlyPausers() {
        if (!pausers[msg.sender]) revert Errors.PauserRequired();
        _;
    }

    /**
     * @notice Initiates the config. Only the protocol owner can set the treasury
     * address, add pausers and pool admins, change the default grace period,
     * treasury fee, add or remove assets to be supported by the protocol.
     */
    constructor() {
        protocolFeeInBps = _DEFAULT_TREASURY_FEE;

        emit ProtocolInitialized(msg.sender);
    }

    /**
     * @notice Adds a pauser, who can pause the entire protocol.
     * @param pauser The address to be added to the pauser list.
     * @custom:access Only the protocol owner can call this function.
     */
    function addPauser(address pauser) external onlyOwner {
        if (pauser == address(0)) revert Errors.ZeroAddressProvided();
        if (pausers[pauser]) revert Errors.AlreadyAPauser();

        pausers[pauser] = true;

        emit PauserAdded(pauser, msg.sender);
    }

    /**
     * @notice Pauses the entire protocol. Used in extreme cases by the pausers.
     * @dev This function will not be governed by timelock due to its sensitivity to timing.
     * @custom:access Only pausers can call this function.
     */
    function pause() external onlyPausers {
        _pause();
    }

    /**
     * @notice Removes a pauser.
     * @param pauser The address to be removed from the pauser list.
     * @custom:access Only the protocol owner can call this function.
     */
    function removePauser(address pauser) external onlyOwner {
        if (pauser == address(0)) revert Errors.ZeroAddressProvided();
        if (!pausers[pauser]) revert Errors.PauserRequired();

        pausers[pauser] = false;

        emit PauserRemoved(pauser, msg.sender);
    }

    /**
     * @notice Sets the address of Huma Treasury.
     * @param treasury The new Huma Treasury address.
     * @custom:access Only the protocol owner can call this function.
     */
    function setHumaTreasury(address treasury) external onlyOwner {
        if (treasury == address(0)) revert Errors.ZeroAddressProvided();
        humaTreasury = treasury;
        emit HumaTreasuryChanged(treasury, msg.sender);
    }

    /**
     * @notice Sets the validity of an asset for liquidity in Huma.
     * @param asset The address of the valid asset.
     * @param valid The new validity status of a Liquidity Asset in pools.
     * @custom:access Only the protocol owner can call this function.
     */
    function setLiquidityAsset(address asset, bool valid) external onlyOwner {
        if (valid) {
            validLiquidityAssets[asset] = true;
            emit LiquidityAssetAdded(asset, msg.sender);
        } else {
            validLiquidityAssets[asset] = false;
            emit LiquidityAssetRemoved(asset, msg.sender);
        }
    }

    /**
     * @notice Sets the service account for Sentinel Service.
     * This is the account that handles various tasks, such as autopay, yield payout, starting
     * a committed credit.
     * @param accountAddress The new Sentinel Service account address.
     * @custom:access Only the protocol owner can call this function.
     */
    function setSentinelServiceAccount(address accountAddress) external onlyOwner {
        if (accountAddress == address(0)) revert Errors.ZeroAddressProvided();
        sentinelServiceAccount = accountAddress;
        emit SentinelServiceAccountChanged(accountAddress, msg.sender);
    }

    /**
     * @notice Sets the treasury fee (in basis points).
     * @param feeInBps The new treasury fee (in bps).
     * @custom:access Only the protocol owner can call this function.
     */
    function setTreasuryFee(uint256 feeInBps) external onlyOwner {
        if (feeInBps > _TREASURY_FEE_UPPER_BOUND) revert Errors.TreasuryFeeHighThanUpperLimit();
        uint256 oldFee = protocolFeeInBps;
        protocolFeeInBps = uint16(feeInBps);
        emit TreasuryFeeChanged(oldFee, feeInBps, msg.sender);
    }

    /**
     * @notice Unpause the entire protocol.
     * @custom:access Only the protocol owner can call this function.
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Reports if the asset is supported by the protocol or not.
     * @param asset The asset to check the validity for.
     * @return Whether the asset is supported.
     */
    function isAssetValid(address asset) external view returns (bool) {
        return validLiquidityAssets[asset];
    }

    /**
     * @notice Reports if the given account is an approved pauser or not.
     * @param account The account to check.
     * @return Whether the account is a pauser.
     */
    function isPauser(address account) external view returns (bool) {
        return pausers[account];
    }
}
