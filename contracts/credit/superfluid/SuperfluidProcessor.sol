// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IERC20, IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {SuperfluidProcessorStorage} from "./SuperfluidProcessorStorage.sol";
import {PoolConfigCache} from "../../PoolConfigCache.sol";
import {PoolConfig, PoolSettings} from "../../PoolConfig.sol";
import {HumaConfig} from "../../HumaConfig.sol";
import {IReceivableFactoringCredit} from "../interfaces/IReceivableFactoringCredit.sol";
import {IReceivable} from "../interfaces/IReceivable.sol";
import {ReceivableInput} from "../CreditStructs.sol";
import {CreditConfig, CreditRecord, CreditState} from "../CreditStructs.sol";
import {TradableStream} from "./TradableStream.sol";
import {Errors} from "../../Errors.sol";
import "../../SharedDefs.sol";

import {ISuperToken} from "@superfluid-finance/ethereum-contracts/contracts/interfaces/superfluid/ISuperfluid.sol";
import {IConstantFlowAgreementV1} from "@superfluid-finance/ethereum-contracts/contracts/interfaces/agreements/IConstantFlowAgreementV1.sol";
import {SuperAppBase} from "@superfluid-finance/ethereum-contracts/contracts/apps/SuperAppBase.sol";

//* Reserved for Richard review, to be deleted, please review this contract

contract SuperfluidProcessor is PoolConfigCache, SuperAppBase, SuperfluidProcessorStorage {
    using SafeERC20 for IERC20;
    using ERC165Checker for address;

    function initialize(
        PoolConfig _poolConfig,
        address _host,
        address _cfa,
        address _tradableStream
    ) external initializer {
        _initialize(_poolConfig);
        host = _host;
        cfa = _cfa;
        tradableStream = _tradableStream;
    }

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = address(_poolConfig.humaConfig());
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        humaConfig = HumaConfig(addr);

        addr = address(_poolConfig.credit());
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        receivableFactoringCredit = IReceivableFactoringCredit(addr);

        addr = address(_poolConfig.receivableAsset());
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        receivableAsset = IReceivable(addr);
    }

    function approveTradableStream(
        address borrower,
        uint96 creditLimit,
        uint16 remainingPeriods,
        uint16 yieldInBps,
        uint96 committedAmount,
        uint64 designatedStartDate,
        SFReceivableInfo memory sfReceivableInfo
    ) external {
        _onlyEAServiceAccount();

        _checkReceivableRequirement(creditLimit, sfReceivableInfo.receivableAmount);

        // Populates fields related to receivable
        if (sfReceivableInfo.receivableAsset == address(0)) revert Errors.zeroAddressProvided();

        _setReceivableInfo(borrower, sfReceivableInfo);

        // TODO here is a sample to mint Receivable
        uint256 tokenId = receivableAsset.createReceivable(
            0,
            sfReceivableInfo.receivableAmount,
            0,
            ""
        );

        receivableFactoringCredit.approveReceivable(
            borrower,
            ReceivableInput(sfReceivableInfo.receivableAmount, uint64(tokenId)),
            creditLimit,
            remainingPeriods,
            yieldInBps,
            committedAmount,
            designatedStartDate
        );

        bytes32 key = keccak256(
            abi.encodePacked(sfReceivableInfo.receivableAsset, sfReceivableInfo.receivableParam)
        );
        _sfReceivableParamInternalReceivableIdMapping[key] = tokenId;
    }

    /**
     * @notice Mint a new NFT representing a receivable asset, and drawdown funds from the pool to the borrower's account
     * @dev The `receivableAsset` must be the same as the `tradableStream` address stored in the contract.
     * @param borrower The address of the borrower who will receive the funds
     * @param borrowAmount The amount of funds to be drawn down from the pool
     * @param receivableAsset The address of the receivable asset used as collateral
     * @param dataForMintTo Additional data to be passed to the `mintTo` function when minting the NFT
     */
    function mintAndDrawdown(
        address borrower,
        uint256 borrowAmount,
        address receivableAsset,
        bytes calldata dataForMintTo
    ) external virtual {
        if (receivableAsset != tradableStream) revert Errors.receivableAssetMismatch();
        address underlyingToken = poolConfig.underlyingToken();
        uint256 internalTokenId = _validateReceivableAsset(
            borrower,
            borrowAmount,
            receivableAsset,
            dataForMintTo,
            underlyingToken
        );

        uint256 allowance = IERC20(underlyingToken).allowance(borrower, address(this));
        if (allowance < borrowAmount) revert Errors.allowanceTooLow();

        _internalCall = true;

        uint256 sfReceivableId = _mintNFT(receivableAsset, dataForMintTo);

        receivableFactoringCredit.drawdownWithReceivable(borrower, internalTokenId, borrowAmount);

        _sfReceivableIdInternalReceivableIdMapping[sfReceivableId] = internalTokenId;

        // TODO add event later
        // emit DrawdownMadeWithReceivable(
        //     address(pool),
        //     borrower,
        //     borrowAmount,
        //     netAmountToBorrower,
        //     receivableAsset,
        //     sfReceivableId
        // );

        _internalCall = false;
    }

    /**
     * @notice Withdraws funds from the NFT and settles the receivable asset.
     * @dev It can be called for the first time only when
     *          a. Flow is terminated(flow rate is 0) and the credit line can be paid off
     *          b. The first due date has expired.
     *      It should pay off the credit line or change its state to delayed. It can be called repeatedly
     *      in the latter case(delayed state).
     *      It should be called to delete streamInfo and burn TradableStream NFT if the borrower paid off
     *      a credit line manually by calling makePaymenet function.
     * @param receivableAsset The address of the receivable asset used as collateral.
     * @param receivableId The ID of the NFT representing the receivable asset.
     */
    function settlement(address receivableAsset, uint256 receivableId) external virtual {
        if (receivableAsset != tradableStream) revert Errors.receivableAssetMismatch();

        StreamInfo memory si = _streamInfoMapping[receivableId];
        if (si.borrower == address(0)) revert Errors.receivableIdMismatch();
        if (block.timestamp <= si.endTime && si.flowrate > 0) revert Errors.settlementTooSoon();

        _internalCall = true;

        IERC20 underlyingToken = IERC20(poolConfig.underlyingToken());

        uint256 beforeAmount = underlyingToken.balanceOf(address(this));
        _withdrawFromNFT(receivableAsset, receivableId, si);
        uint256 amountReceived = underlyingToken.balanceOf(address(this)) - beforeAmount;

        uint256 internalTokenId = _sfReceivableIdInternalReceivableIdMapping[receivableId];
        CreditRecord memory creditRecord = receivableFactoringCredit.getCreditRecord(
            internalTokenId
        );

        if (amountReceived < creditRecord.nextDue) {
            uint256 difference = creditRecord.nextDue - amountReceived;
            uint256 received = _transferFromAccount(
                underlyingToken,
                si.borrower,
                address(this),
                difference
            );
            amountReceived += received;
        }

        bool paidoff;
        if (amountReceived > 0) {
            (, paidoff) = receivableFactoringCredit.makePaymentWithReceivable(
                si.borrower,
                internalTokenId,
                amountReceived
            );
        }

        if (creditRecord.nextDue == 0) {
            // This branch is only for the case when user paid off by pool.makePayment function manually
            // after the loan is delayed
            paidoff = true;
        }

        if (paidoff) {
            delete _streamInfoMapping[receivableId];
            _burnNFT(receivableAsset, receivableId);

            // TODO add event later
            // emit ReceivableCleared(
            //     poolAddr,
            //     si.borrower,
            //     si.flowKey,
            //     receivableAsset,
            //     receivableId
            // );
        }

        // TODO add event later
        // emit SettlementMade(poolAddr, si.borrower, si.flowKey, receivableAsset, receivableId);

        _internalCall = false;
    }

    /**
     * @notice Try to transfer the borrower's allowance and make payment
     * @dev It can be called only when
     *          a. Flow is terminated(flow rate is 0)
     *          b. The settlement function has not be called(credit line state is GoodStanding)
     * @param receivableAsset The address of the receivable asset used as collateral.
     * @param receivableId The ID of the NFT representing the receivable asset.
     */
    function tryTransferAllowance(address receivableAsset, uint256 receivableId) external {
        if (receivableAsset != tradableStream) revert Errors.receivableAssetMismatch();
        StreamInfo memory si = _streamInfoMapping[receivableId];
        if (si.flowrate != 0) revert Errors.invalidFlowrate();

        uint256 internalTokenId = _sfReceivableIdInternalReceivableIdMapping[receivableId];
        CreditRecord memory creditRecord = receivableFactoringCredit.getCreditRecord(
            internalTokenId
        );
        if (creditRecord.state > CreditState.GoodStanding)
            revert Errors.creditLineNotInGoodStandingState();

        uint256 amount = si.receivedFlowAmount;
        IERC20 underlyingToken = IERC20(poolConfig.underlyingToken());
        if (amount < creditRecord.nextDue) {
            uint256 diff = creditRecord.nextDue - amount;
            uint256 received = _transferFromAccount(
                underlyingToken,
                si.borrower,
                address(this),
                diff
            );

            if (received > 0) {
                receivableFactoringCredit.makePaymentWithReceivable(
                    si.borrower,
                    internalTokenId,
                    received
                );
                if (received >= diff) {
                    // TODO add event later
                    // emit ReadyToSettlement(
                    //     address(pool),
                    //     si.borrower,
                    //     tradableStream,
                    //     receivableId,
                    //     block.timestamp
                    // );
                }
            }
        }
    }

    /**
     * @notice Transfer the borrower's allowance and make payment
     * @dev This function is called by bots if the flow associated with a receivable is closed.
     *      It can be called only when the flow is terminated, and it can be called only once.
     *      NotGettingEnoughAllowance will be sent if not getting enough balance from borrowers,
     *      ReadyToSettlement will be sent if getting enough balance.
     * @param flowKey The flow key generated based on ISuperToken, origin and receiver.
     * @param receivableId The ID of the NFT representing the receivable asset.
     */
    function onTerminatedFlow(bytes32 flowKey, uint256 receivableId) external {
        StreamInfo memory si = _streamInfoMapping[receivableId];
        address borrower = si.borrower;
        if (borrower == address(0)) revert Errors.receivableIdMismatch();
        if (si.flowKey != flowKey) revert Errors.flowKeyMismatch();
        uint256 endTime = _flowEndMapping[si.flowKey];
        if (endTime == 0 || endTime <= si.lastStartTime) revert Errors.flowIsNotTerminated();

        uint256 flowrate = si.flowrate;
        si.receivedFlowAmount = (endTime - si.lastStartTime) * flowrate;
        si.lastStartTime = uint64(endTime);
        si.flowrate = 0;

        IERC20 underlyingToken = IERC20(poolConfig.underlyingToken());
        uint256 difference = flowrate * (si.endTime - endTime);
        uint256 received = _transferFromAccount(
            underlyingToken,
            borrower,
            address(this),
            difference
        );

        if (received > 0) {
            uint256 internalTokenId = _sfReceivableIdInternalReceivableIdMapping[receivableId];
            receivableFactoringCredit.makePaymentWithReceivable(
                borrower,
                internalTokenId,
                received
            );
        }

        if (received < difference) {
            // didn't receive enough amount
            // send an event to trigger tryTransferFromBorrower function periodically
            //TODO add event later
            // emit NotGettingEnoughAllowance(address(pool), borrower, tradableStream, receivableId);
        } else {
            // received enough amount from borrower's allowance
            // send an event to notify settlement is ready to be called
            //TODO add event later
            // emit ReadyToSettlement(
            //     address(pool),
            //     borrower,
            //     tradableStream,
            //     receivableId,
            //     block.timestamp
            // );
        }

        _streamInfoMapping[receivableId] = si;
    }

    function afterAgreementUpdated(
        ISuperToken _superToken,
        address _agreementClass,
        bytes32 _agreementId,
        bytes calldata, // _agreementData,
        bytes calldata, // _cbdata,
        bytes calldata _ctx
    ) external virtual override returns (bytes memory newCtx) {
        _onlySuperfluid(msg.sender, _agreementClass);
        (, int96 rate, , ) = IConstantFlowAgreementV1(_agreementClass).getFlowByID(
            _superToken,
            _agreementId
        );
        assert(rate > 0);
        _handleFlowChange(_superToken, _agreementId, uint96(rate));
        newCtx = _ctx;
    }

    function afterAgreementTerminated(
        ISuperToken _superToken,
        address _agreementClass,
        bytes32 _agreementId,
        bytes calldata, // _agreementData,
        bytes calldata, // _cbdata,
        bytes calldata _ctx
    ) external virtual override returns (bytes memory newCtx) {
        _onlySuperfluid(msg.sender, _agreementClass);
        _handleFlowChange(_superToken, _agreementId, 0);
        newCtx = _ctx;
    }

    function afterAgreementCreated(
        ISuperToken /*superToken*/,
        address _agreementClass,
        bytes32 /*agreementId*/,
        bytes calldata /*agreementData*/,
        bytes calldata /*cbdata*/,
        bytes calldata _ctx
    ) external virtual override returns (bytes memory newCtx) {
        _onlySuperfluid(msg.sender, _agreementClass);
        if (_internalCall) {
            newCtx = _ctx;
        } else {
            revert Errors.invalidSuperfluidAction();
        }
    }

    function streamInfoMapping(uint256 receivableId) external view returns (StreamInfo memory) {
        return _streamInfoMapping[receivableId];
    }

    function flowEndMapping(bytes32 flowKey) external view returns (uint256 endTime) {
        endTime = _flowEndMapping[flowKey];
    }

    function _burnNFT(address receivableAsset, uint256 receivableId) internal virtual {
        bool burned = TradableStream(receivableAsset).burned(receivableId);
        if (!burned) {
            (
                ,
                address receiver,
                uint256 duration,
                uint256 started,
                ,
                ISuperToken token,
                int96 flowrate
            ) = TradableStream(receivableAsset).getTradableStreamData(receivableId);

            if (block.timestamp > started + duration && flowrate > 0) {
                // Refund the extra amount to receiver
                // TODO move this logic to TradableStream

                uint256 refundAmount = (block.timestamp - (started + duration)) *
                    uint256(uint96(flowrate));
                uint256 balance = token.balanceOf(address(this));
                uint256 sendAmount = balance < refundAmount ? balance : refundAmount;
                if (sendAmount > 0) {
                    token.transfer(receiver, sendAmount);
                }
            }

            TradableStream(receivableAsset).burn(receivableId);
        }
    }

    function _transferFromAccount(
        IERC20 token,
        address from,
        address to,
        uint256 amount
    ) internal returns (uint256 transferredAmount) {
        uint256 allowance = token.allowance(from, address(this));
        uint256 balance = token.balanceOf(from);
        transferredAmount = amount;
        if (transferredAmount > allowance) transferredAmount = allowance;
        if (transferredAmount > balance) transferredAmount = balance;
        if (transferredAmount > 0) token.safeTransferFrom(from, to, transferredAmount);
    }

    function _withdrawFromNFT(
        address receivableAsset,
        uint256 receivableId,
        StreamInfo memory si
    ) internal virtual {
        ISuperToken token = ISuperToken(si.superToken);
        uint256 amount = si.receivedFlowAmount;
        if (si.endTime > si.lastStartTime) {
            amount += (si.endTime - si.lastStartTime) * si.flowrate;
        }

        if (amount > 0) {
            token.downgradeTo(address(this), amount);

            si.lastStartTime = si.endTime;
            si.receivedFlowAmount = 0;
            _streamInfoMapping[receivableId] = si;
        }
    }

    function _validateReceivableAsset(
        address borrower,
        uint256 borrowAmount,
        address receivableAsset,
        bytes memory dataForMintTo,
        address underlyingToken
    ) internal view returns (uint256 internalTokenId) {
        (
            address receiver,
            address superToken,
            address origin,
            int96 _flowrate,
            uint256 duration,
            ,
            ,
            ,

        ) = abi.decode(
                dataForMintTo,
                (address, address, address, int96, uint256, uint256, uint8, bytes32, bytes32)
            );

        if (borrower != receiver) revert Errors.borrowerMismatch();

        SFReceivableInfo memory ri = _sfReceivableInfoMapping[borrower];
        if (receivableAsset != ri.receivableAsset) revert Errors.receivableAssetMismatch();
        uint256 receivableParam = uint256(
            keccak256(abi.encodePacked(superToken, origin, receiver))
        );
        if (receivableParam == 0 || receivableParam != ri.receivableParam)
            revert Errors.receivableAssetParamMismatch();

        if (_flowrate <= 0) revert Errors.invalidFlowrate();
        uint256 flowrate = uint256(uint96(_flowrate));

        // TODO update this check based on new CreditConfig
        // crs = pool.creditRecordStaticMapping(receiver);
        // if (duration > crs.intervalInDays * SECONDS_IN_A_DAY) revert Errors.durationTooLong();

        uint256 receivableAmount = flowrate * duration;
        receivableAmount = _convertAmount(receivableAmount, superToken, underlyingToken);
        if (receivableAmount < borrowAmount) revert Errors.insufficientReceivableAmount();

        internalTokenId = _sfReceivableParamInternalReceivableIdMapping[
            keccak256(abi.encodePacked(receivableAsset, receivableParam))
        ];
    }

    function _mintNFT(
        address receivableAsset,
        bytes memory data
    ) internal returns (uint256 receivableId) {
        (
            address receiver,
            address superToken,
            address origin,
            int96 flowrate,
            uint256 duration,
            uint256 expiry,
            uint8 v,
            bytes32 r,
            bytes32 s
        ) = abi.decode(
                data,
                (address, address, address, int96, uint256, uint256, uint8, bytes32, bytes32)
            );

        receivableId = TradableStream(receivableAsset).mintToWithAuthorization(
            receiver,
            superToken,
            origin,
            flowrate,
            duration,
            expiry,
            v,
            r,
            s
        );

        bytes32 flowId = keccak256(abi.encode(origin, address(this)));
        bytes32 key = keccak256(abi.encodePacked(superToken, flowId));

        StreamInfo memory streamInfo;
        streamInfo.lastStartTime = uint64(block.timestamp);
        streamInfo.endTime = uint64(block.timestamp + duration);
        streamInfo.flowrate = uint96(flowrate);
        streamInfo.borrower = receiver;
        streamInfo.superToken = superToken;
        streamInfo.flowKey = key;
        // Store a keccak256 hash of the receivableAsset and receivableParam on-chain
        _streamInfoMapping[receivableId] = streamInfo;

        // TODO add event later
        // emit ReceivableFlowKey(address(pool), receiver, receivableId, key);
    }

    /**
     * @notice Convert amount from tokenIn unit to tokenOut unit, e.g. from usdcx to usdc
     * @param amountIn the amount value expressed in tokenIn unit
     * @param tokenIn the address of tokenIn
     * @param tokenOut the address of tokenOut
     * @return amountOut the amount value expressed in tokenOut unit
     */
    function _convertAmount(
        uint256 amountIn,
        address tokenIn,
        address tokenOut
    ) internal view returns (uint256 amountOut) {
        uint256 decimalsIn = IERC20Metadata(tokenIn).decimals();
        uint256 decimalsOut = IERC20Metadata(tokenOut).decimals();
        if (decimalsIn == decimalsOut) {
            amountOut = amountIn;
        } else {
            amountOut = (amountIn * decimalsOut) / decimalsIn;
        }
    }

    /**
     * @notice Checks if the receivable provided is able fulfill the receivable requirement
     * for the requested credit line.
     * @param creditLine the credit limit requested
     * @param receivableAmount the value of the receivable
     */
    function _checkReceivableRequirement(
        uint256 creditLine,
        uint256 receivableAmount
    ) internal view {
        PoolSettings memory ps = poolConfig.getPoolSettings();
        if (receivableAmount < (creditLine * ps.receivableRequiredInBps) / HUNDRED_PERCENT_IN_BPS)
            revert Errors.insufficientReceivableAmount();
    }

    /**
     * @notice Sets the receivable asset for the borrower
     */
    function _setReceivableInfo(
        address borrower,
        SFReceivableInfo memory receivableInfo
    ) internal virtual {
        // If receivables are required, they need to be ERC721.
        if (
            receivableInfo.receivableAsset != address(0) &&
            !receivableInfo.receivableAsset.supportsInterface(type(IERC721).interfaceId)
        ) revert Errors.unsupportedReceivableAsset();
        _sfReceivableInfoMapping[borrower] = receivableInfo;
    }

    function _handleFlowChange(
        ISuperToken superToken,
        bytes32 flowId,
        uint96 newFlowrate
    ) internal {
        if (!_internalCall) {
            bytes32 key = keccak256(abi.encodePacked(superToken, flowId));
            if (newFlowrate == 0) {
                // flow is terminated
                _flowEndMapping[key] = block.timestamp;

                //TODO add event later
                // emit FlowIsTerminated(key, block.timestamp);
            } else {
                // flow is decreased or increased
                revert Errors.invalidSuperfluidAction();
            }
        } else {
            // ignore internal call
        }
    }

    function _onlySuperfluid(address hostValue, address cfaValue) internal view {
        if (host != hostValue || cfa != cfaValue) revert Errors.invalidSuperfluidCallback();
    }

    function _onlyEAServiceAccount() internal view {
        if (msg.sender != humaConfig.eaServiceAccount())
            revert Errors.evaluationAgentServiceAccountRequired();
    }
}
